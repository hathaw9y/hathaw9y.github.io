---
title: OS FSM 설계
date: 2026-06-06 19:21:31 +0900
series: Systolic Array
series_order: 7
categories: Hardware
subcategory: RTL
tags:
  - SystemVerilog
  - Systolic_Array
---
## 개요

앞서 구현한 모듈들을 제어하는 FSM을 설계한다.

이 포스트에서는 **Output Stationary** 기준 Systolic Array FSM을 구현한다.
이 FSM은 단순히 하나의 tile만 계산하지 않고, `M x N` 출력 행렬을 `ROWS x COLS` tile 단위로 순회한다.

전체 역할은 다음과 같다.

- `m_size_i`, `n_size_i`, `k_size_i`를 기준으로 tile 개수 계산
- 현재 M/N tile에 맞는 A/B 주소 생성
- Systolic Array accumulator clear
- K 방향 compute stream 제어
- drain latency 대기
- 결과 tile을 column 단위로 저장
- 마지막 tile까지 끝나면 `done_o` pulse 출력

## 전체 구조

```
BRAM_A (act)    -> bram_loader ┐
                               ├-> gemm_fsm_os -> systolic_array_os -> bram_storer -> BRAM_C (acc)
BRAM_B (weight) -> bram_loader ┘
```

| 모듈 | 역할 |
|---|---|
| `bram_loader` | BRAM에서 A/B vector word 읽기 |
| `gemm_fsm_os` | tile 순회, 주소 생성, valid masking, 상태 제어 |
| `systolic_array_os` | Output Stationary 방식으로 MAC 수행 |
| `bram_storer` | 계산된 C tile을 BRAM에 저장 |

## FSM 상태

IDLE -> CLEAR -> COMPUTE -> DRAIN -> STORE -> DONE

| 상태 | 설명 |
|---|---|
| `IDLE` | 시작 신호 대기, 크기와 base address latch |
| `CLEAR` | Systolic Array 내부 accumulator 초기화 |
| `COMPUTE` | K 방향으로 A/B vector stream |
| `DRAIN` | 마지막 입력이 배열 내부를 통과할 때까지 대기 |
| `STORE` | PE에 남아 있는 output tile을 column 단위로 저장 |
| `DONE` | 전체 GEMM 완료 pulse 출력 후 IDLE 복귀 |

## FSM 구현

### 포트 구성

`gemm_fsm_os`는 start_i와 done_o로 시작, 종료를 알리고, 전체 GEMM 크기와 base address를 입력으로 받는다.

```verilog
input  logic                start_i,
output logic                done_o
input  logic [  ADDR_W-1:0] m_size_i,
input  logic [  ADDR_W-1:0] n_size_i,
input  logic [  ADDR_W-1:0] k_size_i,
input  logic [  ADDR_W-1:0] act_base_addr_i,
input  logic [  ADDR_W-1:0] weight_base_addr_i,
input  logic [  ADDR_W-1:0] acc_base_addr_i,
```

그리고 act/weight loader, systolic array, storer를 각각 제어한다.

```verilog
// bram_loader (act) 인터페이스
output logic                       act_loader_en_o,
output logic        [  ADDR_W-1:0] act_loader_addr_o,
input  logic signed [   ACT_W-1:0] act_loader_data_i    [ROWS],
input  logic                       act_loader_valid_i,
// bram_loader (weight) 인터페이스
output logic                       weight_loader_en_o,
output logic        [  ADDR_W-1:0] weight_loader_addr_o,
input  logic signed [WEIGHT_W-1:0] weight_loader_data_i [COLS],
input  logic                       weight_loader_valid_i,
// systolic_array_os 인터페이스
output logic signed [   ACT_W-1:0] act_o                [ROWS],
output logic signed [WEIGHT_W-1:0] weight_o             [COLS],
output logic                       act_valid_o          [ROWS],
output logic                       weight_valid_o       [COLS],
output logic                       acc_clear_o,
input  logic signed [   ACC_W-1:0] acc_i                [ROWS][COLS],
// bram_storer 인터페이스
output logic                       storer_valid_o,
output logic        [  ADDR_W-1:0] storer_addr_o,
output logic signed [   ACC_W-1:0] storer_data_o        [ROWS]
```

### 동작 흐름

#### IDLE

`start_i`가 1이 되면 전체 GEMM 크기와 base address를 latch한다.

```verilog
m_size_r           <= m_size_i;
n_size_r           <= n_size_i;
k_size_r           <= k_size_i;
act_base_addr_r    <= act_base_addr_i;
weight_base_addr_r <= weight_base_addr_i;
acc_base_addr_r    <= acc_base_addr_i;
```

동시에 M/N 방향 tile 개수를 계산한다.

```verilog
m_tiles_r <= ceil_div_const(m_size_i, ROWS_W);
n_tiles_r <= ceil_div_const(n_size_i, COLS_W);
k_last_r  <= (k_size_i == '0) ? '0 : k_size_i - ADDR_W'(1);
```

그리고 전체 결과가 tile 하나로 끝나는 경우를 위해 `last_tile_r`도 함께 초기화한다.

```verilog
last_tile_r <= (ceil_div_const(m_size_i, ROWS_W) == ADDR_W'(1)) &&
               (ceil_div_const(n_size_i, COLS_W) == ADDR_W'(1));
```

`M`, `N`, `K` 중 하나라도 0이면 연산할 것이 없으므로 바로 `DONE`으로 이동한다.
정상 입력이면 `CLEAR`로 이동한다.

#### CLEAR

Output Stationary에서는 각 PE 내부 accumulator에 부분합이 남는다.
따라서 새 tile 계산을 시작하기 전에 accumulator를 clear해야 한다.

```verilog
acc_clear_o <= 1'b1;
```

`CLEAR`는 1 cycle pulse로 동작하고 다음 상태는 `COMPUTE`이다.

#### COMPUTE

`COMPUTE` 상태에서는 현재 output tile에 필요한 A/B vector word를 K 방향으로 stream한다.
메모리 배치는 앞선 [메모리 레이아웃](/hardware/SA-6-Memory_Layout/) 글에서 정한 OS layout을 따른다.

```verilog
act_loader_en_o      <= 1'b1;
act_loader_addr_o    <= act_base_addr_r + (m_tile_idx_r * k_size_r) + k_cnt;

weight_loader_en_o   <= 1'b1;
weight_loader_addr_o <= weight_base_addr_r + (n_tile_idx_r * k_size_r) + k_cnt;
```

여기서 `k_cnt`는 현재 tile 안에서 읽고 있는 K offset이다.
`k_cnt == k_last_r`이 되면 더 이상 읽을 K 데이터가 없으므로 `DRAIN`으로 넘어간다.

loader에서 읽은 데이터는 systolic array 입력으로 바로 연결한다.

```verilog
act_o    = act_loader_data_i;
weight_o = weight_loader_data_i;
```

단, edge tile에서는 `ROWS` 또는 `COLS`를 꽉 채우지 못할 수 있다.
예를 들어 `M = 30`, `ROWS = 16`이면 마지막 M tile에는 유효 row가 14개뿐이다.
따라서 valid 신호를 row/column 단위로 masking한다.

```verilog
for (int r = 0; r < ROWS; r++) begin
  act_valid_o[r] = act_loader_valid_i && (ADDR_W'(r) < tile_m_w);
end

for (int c = 0; c < COLS; c++) begin
  weight_valid_o[c] = weight_loader_valid_i && (ADDR_W'(c) < tile_n_w);
end
```

현재 tile에서 실제로 유효한 row/column 수는 아래처럼 계산한다.

```verilog
m_offset_w = m_tile_idx_r * ROWS_W;
n_offset_w = n_tile_idx_r * COLS_W;

tile_m_w = min_const(m_size_r - m_offset_w, ROWS_W);
tile_n_w = min_const(n_size_r - n_offset_w, COLS_W);
```

#### DRAIN

마지막 데이터가 배열을 완전히 통과할 때까지 대기한다.

16x16 배열 기준으로 skewing 때문에 마지막 데이터가 오른쪽 아래 PE까지 도달하려면 추가로 `ROWS + COLS - 2` cycle이 필요하다.

$$t_{drain} = ROWS + COLS - 2 = 30 \text{ cycles}$$

코드에서는 이를 `DRAIN_LAST`로 정의한다.

```verilog
localparam int DRAIN_LAST = ROWS + COLS - 2;
```

`drain_cnt == DRAIN_LAST_W`가 되면 `STORE`로 이동한다.

#### STORE

`STORE` 상태에서는 output tile을 column 단위로 저장한다.
실제 C layout 자체는 메모리 레이아웃 글에서 설명했으므로, 여기서는 FSM이 어떤 column을 선택해 storer로 넘기는지만 보면 된다.

```verilog
storer_valid_o <= 1'b1;
storer_addr_o  <= acc_base_addr_r + (tile_linear_idx_w * COLS_W) + ADDR_W'(store_cnt);
```

`acc_i`는 `[row][col]` 형태이므로, 현재 저장할 column은 `store_col_idx`로 선택한다.

```verilog
for (int r = 0; r < ROWS; r++) begin
  if (ADDR_W'(r) < tile_m_w) begin
    storer_data_o[r] <= acc_i[r][store_col_idx];
  end
end
```

edge tile에서는 유효 row만 저장한다.
또한 마지막 N tile에서는 유효 column 수가 `COLS`보다 작을 수 있으므로 `tile_n_last_w`까지만 store한다.

```verilog
if (store_cnt == STORE_CNT_W'(tile_n_last_w)) begin
  next_state = last_tile_r ? DONE : CLEAR;
end
```

현재 tile 저장이 끝나면 다음 tile로 이동한다.
순회 순서는 N tile을 먼저 증가시키고, N 방향이 끝나면 다음 M tile로 넘어간다.
이때 새 코드에서는 다음 tile index를 갱신하면서, 다음 tile이 마지막 tile인지 `last_tile_r`에 미리 저장한다.

```verilog
if (store_cnt == STORE_CNT_W'(tile_n_last_w)) begin
  store_cnt <= '0;

  if (!last_tile_r) begin
    if (n_tile_idx_r == n_tiles_r - ADDR_W'(1)) begin
      n_tile_idx_r <= '0;
      m_tile_idx_r <= m_tile_idx_r + ADDR_W'(1);
      last_tile_r  <= (m_tile_idx_r + ADDR_W'(1) == m_tiles_r - ADDR_W'(1)) &&
                      (n_tiles_r == ADDR_W'(1));
    end else begin
      n_tile_idx_r <= n_tile_idx_r + ADDR_W'(1);
      last_tile_r  <= (m_tile_idx_r == m_tiles_r - ADDR_W'(1)) &&
                      (n_tile_idx_r + ADDR_W'(1) == n_tiles_r - ADDR_W'(1));
    end
  end
end else begin
  store_cnt <= store_cnt + STORE_CNT_W'(1);
end
```

이렇게 하면 `STORE` 상태의 next-state 판단에서 현재 tile이 마지막인지 바로 알 수 있다.
즉 마지막 tile을 저장한 cycle에는 `last_tile_r`가 이미 1이므로 `DONE`으로 이동하고, 그렇지 않으면 다음 tile 계산을 위해 `CLEAR`로 돌아간다.

#### DONE

마지막 tile까지 모두 저장하면 `DONE` 상태에서 `done_o`를 1 cycle pulse로 출력한다.

```verilog
done_o <= 1'b1;
```

다음 cycle에는 다시 `IDLE`로 복귀한다.

## 주소 생성 정리

```verilog
act_loader_addr_o = act_base_addr_r + (m_tile_idx_r * k_size_r) + k_cnt;

weight_loader_addr_o = weight_base_addr_r + (n_tile_idx_r * k_size_r) + k_cnt;

tile_linear_idx_w = (m_tile_idx_r * n_tiles_r) + n_tile_idx_r;
storer_addr_o = acc_base_addr_r + (tile_linear_idx_w * COLS_W) + store_cnt;
```

세 주소식은 모두 `m_tile_idx_r`, `n_tile_idx_r`, `k_cnt`, `store_cnt` 같은 FSM counter에서 만들어진다.
즉 이 글의 관심사는 memory layout 자체가 아니라, 현재 FSM 상태에서 어떤 counter를 증가시키고 어떤 주소를 출력할지이다.

## 핵심 포인트

- `CLEAR` 상태를 따로 두어 OS accumulator를 tile마다 초기화한다.
- `COMPUTE`는 K 방향 stream만 담당한다.
- `DRAIN`은 systolic array 내부 latency를 보상한다.
- `STORE`는 `acc_i[row][col]`에서 column을 선택해 BRAM에 쓴다.
- edge tile에서는 `tile_m_w`, `tile_n_w`로 valid와 store 범위를 masking한다.
- 전체 GEMM은 `(m_tile_idx_r, n_tile_idx_r)`를 순회하며 처리한다.

## systolic_array_fsm_os.sv

```verilog
module systolic_array_fsm_os #(
    parameter int ROWS     = 16,
    parameter int COLS     = 16,
    parameter int ACT_W    = 8,
    parameter int WEIGHT_W = 8,
    parameter int ACC_W    = 32,
    parameter int ADDR_W   = 10
) (
    input  logic                       aclk_i,
    input  logic                       aresetn_i,
    input  logic                       start_i,
    input  logic        [  ADDR_W-1:0] m_size_i,
    input  logic        [  ADDR_W-1:0] n_size_i,
    input  logic        [  ADDR_W-1:0] k_size_i,
    input  logic        [  ADDR_W-1:0] act_base_addr_i,
    input  logic        [  ADDR_W-1:0] weight_base_addr_i,
    input  logic        [  ADDR_W-1:0] acc_base_addr_i,
    // bram_loader (act) 인터페이스
    output logic                       act_loader_en_o,
    output logic        [  ADDR_W-1:0] act_loader_addr_o,
    input  logic signed [   ACT_W-1:0] act_loader_data_i    [ROWS],
    input  logic                       act_loader_valid_i,
    // bram_loader (weight) 인터페이스
    output logic                       weight_loader_en_o,
    output logic        [  ADDR_W-1:0] weight_loader_addr_o,
    input  logic signed [WEIGHT_W-1:0] weight_loader_data_i [COLS],
    input  logic                       weight_loader_valid_i,
    // systolic_array_os 인터페이스
    output logic signed [   ACT_W-1:0] act_o                [ROWS],
    output logic signed [WEIGHT_W-1:0] weight_o             [COLS],
    output logic                       act_valid_o          [ROWS],
    output logic                       weight_valid_o       [COLS],
    output logic                       acc_clear_o,
    input  logic signed [   ACC_W-1:0] acc_i                [ROWS][COLS],
    // bram_storer 인터페이스
    output logic                       storer_valid_o,
    output logic        [  ADDR_W-1:0] storer_addr_o,
    output logic signed [   ACC_W-1:0] storer_data_o        [ROWS],
    output logic                       done_o
);

  // OS GEMM 전체 제어 FSM.
  // 한 번 start되면 전체 MxN 결과를 tile 단위로 순회한다.
  // 메모리 layout 가정:
  //   A: m_tile마다 K개의 vector word, 각 word는 ROWS개 activation
  //   B: n_tile마다 K개의 vector word, 각 word는 COLS개 weight
  //   C: tile마다 COLS개의 vector word, 각 word는 ROWS개 result
  typedef enum logic [2:0] {
    IDLE    = 3'd0,
    CLEAR   = 3'd1,  // systolic array 내부 accumulator 초기화
    COMPUTE = 3'd2,  // K 방향으로 A/B vector를 stream
    DRAIN   = 3'd3,  // 마지막 입력이 array 내부를 지나갈 때까지 대기
    STORE   = 3'd4,  // PE에 남은 output tile을 column 단위로 저장
    DONE    = 3'd5   // 전체 GEMM 완료 pulse
  } state_t;

  // 마지막 입력 이후 결과가 우하단까지 전파되는 데 필요한 대기 cycle.
  localparam int DRAIN_LAST = ROWS + COLS - 2;
  localparam int DRAIN_CNT_W = $clog2(ROWS + COLS) + 1;
  localparam int STORE_CNT_W = $clog2(COLS) + 1;
  localparam int STORE_IDX_W = (COLS <= 1) ? 1 : $clog2(COLS);

  localparam logic [ADDR_W-1:0] ROWS_W = ADDR_W'(ROWS);
  localparam logic [ADDR_W-1:0] COLS_W = ADDR_W'(COLS);
  localparam logic [DRAIN_CNT_W-1:0] DRAIN_LAST_W = DRAIN_CNT_W'(DRAIN_LAST);

  state_t state, next_state;

  logic [     ADDR_W-1:0] m_size_r;
  logic [     ADDR_W-1:0] n_size_r;
  logic [     ADDR_W-1:0] k_size_r;
  logic [     ADDR_W-1:0] act_base_addr_r;
  logic [     ADDR_W-1:0] weight_base_addr_r;
  logic [     ADDR_W-1:0] acc_base_addr_r;

  logic [     ADDR_W-1:0] m_tiles_r;  // M 방향 tile 개수 = ceil(M / ROWS)
  logic [     ADDR_W-1:0] n_tiles_r;  // N 방향 tile 개수 = ceil(N / COLS)
  logic [     ADDR_W-1:0] m_tile_idx_r;  // 현재 M tile index
  logic [     ADDR_W-1:0] n_tile_idx_r;  // 현재 N tile index
  logic [     ADDR_W-1:0] k_cnt;  // 현재 tile 안에서 읽는 K offset
  logic [     ADDR_W-1:0] k_last_r;  // k_size_i - 1
  logic [DRAIN_CNT_W-1:0] drain_cnt;
  logic [STORE_CNT_W-1:0] store_cnt;
  logic [STORE_IDX_W-1:0] store_col_idx;

  logic [     ADDR_W-1:0] m_offset_w;
  logic [     ADDR_W-1:0] n_offset_w;
  logic [     ADDR_W-1:0] tile_linear_idx_w;
  logic [     ADDR_W-1:0] tile_m_w;
  logic [     ADDR_W-1:0] tile_n_w;
  logic [     ADDR_W-1:0] tile_m_last_w;
  logic [     ADDR_W-1:0] tile_n_last_w;
  logic                   last_tile_r;

  // 현재 tile의 global offset과 edge tile의 유효 row/col 수 계산.
  assign store_col_idx = store_cnt[STORE_IDX_W-1:0];
  assign m_offset_w = m_tile_idx_r * ROWS_W;
  assign n_offset_w = n_tile_idx_r * COLS_W;
  assign tile_linear_idx_w = (m_tile_idx_r * n_tiles_r) + n_tile_idx_r;
  assign tile_m_w = min_const(m_size_r - m_offset_w, ROWS_W);
  assign tile_n_w = min_const(n_size_r - n_offset_w, COLS_W);
  assign tile_m_last_w = (tile_m_w == '0) ? '0 : tile_m_w - ADDR_W'(1);
  assign tile_n_last_w = (tile_n_w == '0) ? '0 : tile_n_w - ADDR_W'(1);

  function automatic logic [ADDR_W-1:0] ceil_div_const(input logic [ADDR_W-1:0] value,
                                                       input logic [ADDR_W-1:0] denom);
    begin
      ceil_div_const = (value == '0) ? '0 : ((value - ADDR_W'(1)) / denom) + ADDR_W'(1);
    end
  endfunction

  function automatic logic [ADDR_W-1:0] min_const(input logic [ADDR_W-1:0] value,
                                                  input logic [ADDR_W-1:0] limit);
    begin
      min_const = (value > limit) ? limit : value;
    end
  endfunction

  always_ff @(posedge aclk_i) begin
    if (!aresetn_i) state <= IDLE;
    else state <= next_state;
  end

  always_comb begin
    next_state = state;
    case (state)
      IDLE: begin
        // 크기가 0인 GEMM은 바로 DONE으로 처리한다.
        if (start_i && (m_size_i != '0) && (n_size_i != '0) && (k_size_i != '0)) begin
          next_state = CLEAR;
        end else if (start_i) begin
          next_state = DONE;
        end
      end

      CLEAR: begin
        next_state = COMPUTE;
      end

      COMPUTE: begin
        if (k_cnt == k_last_r) next_state = DRAIN;
      end

      DRAIN: begin
        if (drain_cnt == DRAIN_LAST_W) next_state = STORE;
      end

      STORE: begin
        // 현재 tile의 유효 column만 저장한 뒤 다음 tile 또는 DONE으로 이동한다.
        if (store_cnt == STORE_CNT_W'(tile_n_last_w)) begin
          next_state = last_tile_r ? DONE : CLEAR;
        end
      end

      DONE: begin
        next_state = IDLE;
      end

      default: begin
        next_state = IDLE;
      end
    endcase
  end

  always_ff @(posedge aclk_i) begin
    if (!aresetn_i) begin
      m_size_r           <= '0;
      n_size_r           <= '0;
      k_size_r           <= '0;
      act_base_addr_r    <= '0;
      weight_base_addr_r <= '0;
      acc_base_addr_r    <= '0;
      m_tiles_r          <= '0;
      n_tiles_r          <= '0;
      m_tile_idx_r       <= '0;
      n_tile_idx_r       <= '0;
      k_cnt              <= '0;
      k_last_r           <= '0;
      drain_cnt          <= '0;
      store_cnt          <= '0;
      last_tile_r        <= 1'b0;
    end else begin
      case (state)
        IDLE: begin
          // start 시 전체 크기와 base address를 latch한다.
          m_tile_idx_r <= '0;
          n_tile_idx_r <= '0;
          k_cnt        <= '0;
          drain_cnt    <= '0;
          store_cnt    <= '0;
          last_tile_r  <= 1'b0;

          if (start_i) begin
            m_size_r           <= m_size_i;
            n_size_r           <= n_size_i;
            k_size_r           <= k_size_i;
            act_base_addr_r    <= act_base_addr_i;
            weight_base_addr_r <= weight_base_addr_i;
            acc_base_addr_r    <= acc_base_addr_i;
            m_tiles_r          <= ceil_div_const(m_size_i, ROWS_W);
            n_tiles_r          <= ceil_div_const(n_size_i, COLS_W);
            k_last_r           <= (k_size_i == '0) ? '0 : k_size_i - ADDR_W'(1);
            last_tile_r        <= (ceil_div_const(m_size_i, ROWS_W) == ADDR_W'(1)) &&
                                  (ceil_div_const(n_size_i, COLS_W) == ADDR_W'(1));
          end
        end

        COMPUTE: begin
          k_cnt <= (k_cnt == k_last_r) ? '0 : k_cnt + ADDR_W'(1);
        end

        DRAIN: begin
          drain_cnt <= (drain_cnt == DRAIN_LAST_W) ? '0 : drain_cnt + DRAIN_CNT_W'(1);
        end

        STORE: begin
          // N tile을 먼저 증가시키고, N 끝에 도달하면 다음 M tile로 넘어간다.
          if (store_cnt == STORE_CNT_W'(tile_n_last_w)) begin
            store_cnt <= '0;

            if (!last_tile_r) begin
              if (n_tile_idx_r == n_tiles_r - ADDR_W'(1)) begin
                n_tile_idx_r <= '0;
                m_tile_idx_r <= m_tile_idx_r + ADDR_W'(1);
                last_tile_r  <= (m_tile_idx_r + ADDR_W'(1) == m_tiles_r - ADDR_W'(1)) &&
                                (n_tiles_r == ADDR_W'(1));
              end else begin
                n_tile_idx_r <= n_tile_idx_r + ADDR_W'(1);
                last_tile_r  <= (m_tile_idx_r == m_tiles_r - ADDR_W'(1)) &&
                                (n_tile_idx_r + ADDR_W'(1) == n_tiles_r - ADDR_W'(1));
              end
            end
          end else begin
            store_cnt <= store_cnt + STORE_CNT_W'(1);
          end
        end

        default: begin
          // 유지
        end
      endcase
    end
  end

  always_ff @(posedge aclk_i) begin
    if (!aresetn_i) begin
      act_loader_en_o      <= 1'b0;
      act_loader_addr_o    <= '0;
      weight_loader_en_o   <= 1'b0;
      weight_loader_addr_o <= '0;
      acc_clear_o          <= 1'b0;
      storer_valid_o       <= 1'b0;
      storer_addr_o        <= '0;
      storer_data_o        <= '{default: '0};
      done_o               <= 1'b0;
    end else begin
      act_loader_en_o    <= 1'b0;
      weight_loader_en_o <= 1'b0;
      acc_clear_o        <= 1'b0;
      storer_valid_o     <= 1'b0;
      storer_data_o      <= '{default: '0};
      done_o             <= 1'b0;

      case (state)
        CLEAR: begin
          acc_clear_o <= 1'b1;
        end

        COMPUTE: begin
          // 각 주소는 현재 tile base + K offset.
          act_loader_en_o      <= 1'b1;
          act_loader_addr_o    <= act_base_addr_r + (m_tile_idx_r * k_size_r) + k_cnt;
          weight_loader_en_o   <= 1'b1;
          weight_loader_addr_o <= weight_base_addr_r + (n_tile_idx_r * k_size_r) + k_cnt;
        end

        STORE: begin
          // C tile은 act layout처럼 column 단위로 저장한다.
          // 한 주소에는 같은 column의 ROWS개 result가 들어간다.
          storer_valid_o <= 1'b1;
          storer_addr_o  <= acc_base_addr_r + (tile_linear_idx_w * COLS_W) + ADDR_W'(store_cnt);
          for (int r = 0; r < ROWS; r++) begin
            if (ADDR_W'(r) < tile_m_w) begin
              storer_data_o[r] <= acc_i[r][store_col_idx];
            end
          end
        end

        DONE: begin
          done_o <= 1'b1;
        end

        default: begin
          // pulse 출력 외에는 기본값 유지
        end
      endcase
    end
  end

  always_comb begin
    // loader data는 systolic array 입력으로 바로 연결한다.
    // valid는 edge M/N tile에서 유효 row/col만 켜도록 masking한다.
    act_o          = act_loader_data_i;
    weight_o       = weight_loader_data_i;
    act_valid_o    = '{default: 1'b0};
    weight_valid_o = '{default: 1'b0};

    for (int r = 0; r < ROWS; r++) begin
      act_valid_o[r] = act_loader_valid_i && (ADDR_W'(r) < tile_m_w);
    end

    for (int c = 0; c < COLS; c++) begin
      weight_valid_o[c] = weight_loader_valid_i && (ADDR_W'(c) < tile_n_w);
    end
  end

endmodule
```
