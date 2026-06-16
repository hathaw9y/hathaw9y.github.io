---
title: WS FSM 설계
date: 2026-06-06 20:12:00 +0900
series: Systolic Array
series_order: 8
categories: Hardware
subcategory: RTL
tags:
  - SystemVerilog
  - Systolic_Array
---
## 개요

이번 글에서는 **Weight Stationary** 기준 Systolic Array FSM을 설계한다.
OS FSM은 output tile 하나를 완성한 뒤 다음 tile로 넘어갔다.
반면 WS FSM은 weight를 PE 내부에 먼저 load하고, activation을 흘려 partial sum을 만든다.

WS FSM의 핵심은 세 가지다.

- weight를 PE array 내부에 먼저 load한다
- K가 `ROWS`보다 크면 partial sum을 BRAM에 저장했다가 다시 읽어 누적한다
- 출력은 한 번에 한 row의 `COLS`개 result vector로 나온다

즉 OS처럼 `ROWS x COLS` output tile 전체가 한 번에 PE 내부에 남는 구조가 아니다.
WS에서는 `m_idx` 하나와 `n_tile_idx` 하나를 기준으로 `COLS`개 결과를 만들고, K tile을 바꿔가며 partial sum을 누적한다.

FPGA 관점에서 WS FSM이 복잡한 이유는 memory read와 compute가 같은 cycle에 즉시 끝나지 않기 때문이다.
BRAM read에는 latency가 있고, weight는 PE chain 안으로 여러 cycle에 걸쳐 밀려 들어가며, array output도 valid가 내려올 때까지 기다려야 한다.
따라서 software처럼 `load; compute; add; store`를 한 줄씩 실행하는 것이 아니라, 각 단계가 끝났다는 valid pulse를 기준으로 다음 상태로 넘어가야 한다.

## 전체 구조

```verilog
BRAM_A (act) ---------> bram_loader ┐
                                    ├-> systolic_array_ws -> accumulator -> bram_storer -> BRAM_C
BRAM_B (weight) ------> bram_loader ┘                       ^
                                                            |
BRAM_C (partial sum) -> bram_loader ------------------------┘
```

| 모듈 | 역할 |
|---|---|
| `bram_loader (act)` | 현재 row와 K tile에 해당하는 activation vector 읽기 |
| `bram_loader (weight)` | 현재 `n_tile`, `k_tile`의 weight를 PE 내부에 load |
| `systolic_array_ws` | weight stationary 방식으로 MAC 수행 |
| `bram_loader (acc partial)` | 이전 K tile까지의 partial sum 읽기 |
| `accumulator` | 새 partial sum과 기존 partial sum 누적 |
| `bram_storer` | 누적 결과를 다시 BRAM_C에 저장 |

## FSM 상태

```verilog
IDLE
-> LOAD_WEIGHT
-> WEIGHT_FLUSH
-> READ_ACT
-> WAIT_ACC
-> READ_PARTIAL
-> DONE
```

| 상태 | 설명 |
|---|---|
| `IDLE` | 시작 신호 대기, 크기와 base address latch |
| `LOAD_WEIGHT` | 현재 K tile의 weight를 PE 내부에 load |
| `WEIGHT_FLUSH` | BRAM read latency 때문에 마지막 weight valid를 한 cycle 더 전달 |
| `READ_ACT` | 현재 `m_idx`, `k_tile`에 해당하는 activation vector 읽기 |
| `WAIT_ACC` | WS array에서 `acc_i[COLS]`가 valid해질 때까지 대기 |
| `READ_PARTIAL` | 이전 K tile partial sum을 BRAM_C에서 읽어 누적 |
| `DONE` | 전체 연산 완료 pulse 출력 |

## Tile Counter

WS FSM은 `m_idx`, `n_tile_idx`, `k_tile_idx`, `last_tile_r`를 사용한다.

```verilog
logic [ADDR_W-1:0] m_idx_r;
logic [ADDR_W-1:0] n_tile_idx_r;
logic [ADDR_W-1:0] k_tile_idx_r;
logic              last_tile_r;
```

여기서 `m_idx_r`는 M 방향 **tile index가 아니라 실제 output row index**에 가깝다.
이 WS 구조는 한 번에 한 output row와 `COLS`개 output column을 계산하기 때문이다.

`n_tile_idx_r`는 N 방향 output column tile을 의미한다.
`k_tile_idx_r`는 K 방향을 `ROWS`개씩 나눈 tile index이다.
`last_tile_r`는 현재 처리 중인 `(m_idx, n_tile)`이 마지막 output 위치인지 나타낸다.

```verilog
n_tiles_r <= ceil_div_const(n_size_i, COLS_W);
k_tiles_r <= ceil_div_const(k_size_i, ROWS_W);
```

`IDLE`에서 전체 크기를 latch할 때, 전체 연산이 output row 하나와 N tile 하나로 끝나는 경우를 미리 계산한다.

```verilog
last_tile_r <= (m_size_i == ADDR_W'(1)) &&
               (ceil_div_const(n_size_i, COLS_W) == ADDR_W'(1));
```

각 K tile은 activation `ROWS`개와 weight row `ROWS`개를 사용한다.
구체적인 WS activation/weight 배치는 앞선 [메모리 레이아웃](/hardware/SA-6-Memory_Layout/) 글에서 설명했으므로, 이 글에서는 FSM이 해당 layout을 어떻게 읽는지만 다룬다.

## Weight Load

WS에서는 compute 전에 weight를 PE 내부에 먼저 load해야 한다.
현재 `n_tile_idx_r`, `k_tile_idx_r`에 해당하는 weight block을 읽어 PE array로 밀어 넣는다.

```verilog
weight_loader_en_o <= 1'b1;
weight_loader_addr_o <= weight_base_addr_r +
                        (((n_tile_idx_r * k_tiles_r) + k_tile_idx_r) * ROWS_W) +
                        weight_load_row_w;
```

여기서 중요한 제어 포인트는 `weight_load_row_w`이다.
메모리에는 weight block이 낮은 주소부터 저장되어 있지만, load할 때는 PE 내부 배치 방향을 맞추기 위해 block 내부를 역순으로 읽는다.

```verilog
weight_load_row_w = (ROWS_W - ADDR_W'(1)) - ADDR_W'(weight_load_cnt);
```

이유는 weight load chain 때문이다.
weight는 PE array 내부로 한 cycle씩 밀려 들어간다.
먼저 넣은 weight는 아래쪽 row로 이동하고, 마지막에 넣은 weight는 위쪽 row에 남는다.
따라서 최종적으로 각 row의 PE가 올바른 weight를 잡도록 하려면 BRAM에서는 block 내부를 역순으로 읽어야 한다.

이 부분은 WS 설계에서 가장 실수하기 쉽다.
메모리에 저장된 순서와 PE에 최종적으로 고정되어야 하는 위치가 같아 보이더라도, 중간에 register chain을 통과하면서 위치가 한 cycle씩 밀린다.
그래서 FSM은 단순히 주소를 증가시키는 것이 아니라, PE 내부 이동 방향까지 고려해 읽는 순서를 정해야 한다.

## Activation Read

weight load가 끝나면 현재 output row에 대한 activation vector를 읽는다.

```verilog
act_loader_en_o   <= 1'b1;
act_loader_addr_o <= act_base_addr_r + (k_tile_idx_r * m_size_r) + m_idx_r;
```

주소식은 다음과 같다.

```verilog
A_addr = act_base + k_tile * M + m_idx
```

activation memory는 K tile 기준으로 M 방향 row를 저장한다.
FSM은 현재 `k_tile_idx_r`와 `m_idx_r`만으로 필요한 activation word를 선택한다.

edge K tile에서는 `tile_k_w`보다 큰 lane을 0으로 채운다.
다만 valid chain은 끊기지 않도록 valid는 그대로 흘린다.

```verilog
for (int r = 0; r < ROWS; r++) begin
  if (ADDR_W'(r) < tile_k_w) begin
    act_o[r] = act_loader_data_i[r];
  end else begin
    act_o[r] = '0;
  end

  act_valid_o[r] = act_loader_valid_i;
end
```

## Partial Sum 누적

WS에서는 K tile 하나를 처리할 때마다 `acc_i[COLS]`가 나온다.
첫 번째 K tile이면 이전 partial sum이 없으므로 바로 저장하면 된다.

```verilog
if ((state == WAIT_ACC) && all_acc_valid_w && first_k_tile_w) begin
  accum_valid_o = 1'b1;
  for (int c = 0; c < COLS; c++) begin
    accum_partial_data_o[c] = acc_i[c];
  end
end
```

하지만 두 번째 K tile부터는 이전 partial sum을 BRAM_C에서 읽어야 한다.

이 구조에서는 Accumulator BRAM이 단순 output 저장소가 아니라 partial sum buffer 역할도 한다.
즉 WS Engine은 한 주소를 읽고, 새 partial sum과 더한 뒤, 다시 같은 주소에 write-back한다.
이 read-modify-write 흐름 때문에 BRAM read latency와 accumulator valid timing이 FSM 상태에 포함된다.

```verilog
if (all_acc_valid_w && !first_k_tile_w) begin
  acc_loader_en_o   <= 1'b1;
  acc_loader_addr_o <= acc_addr_w;
end
```

partial sum 주소는 현재 output row와 N tile로 결정된다.

```verilog
acc_addr_w = acc_base_addr_r + (m_idx_r * n_tiles_r) + n_tile_idx_r;
```

주소식으로 쓰면 다음과 같다.

```verilog
C_addr = acc_base + m_idx * n_tiles + n_tile
```

한 주소에는 현재 row의 `COLS`개 결과가 들어 있다.
구체적인 C word packing은 메모리 레이아웃 글에서 설명한 WS C layout을 따른다.

이전 partial sum을 읽은 뒤에는 새 partial sum과 더한다.

```verilog
if ((state == READ_PARTIAL) && acc_loader_valid_i) begin
  accum_valid_o = 1'b1;
  for (int c = 0; c < COLS; c++) begin
    accum_old_data_o[c]     = acc_loader_data_i[c];
    accum_partial_data_o[c] = array_acc_r[c];
  end
end
```

여기서 실제 덧셈은 별도의 `accumulator` 모듈이 담당한다.
첫 번째 K tile에서는 이전 partial sum이 없으므로 `partial_data_i`를 그대로 통과시키고, 이후 K tile부터는 BRAM에서 읽은 `old_data_i`와 새로 계산된 `partial_data_i`를 더한다.

### accumulator.sv

```verilog
module accumulator #(
    parameter int LANES  = 16,
    parameter int DATA_W = 32
) (
    input  logic                         valid_i,
    input  logic                         first_i,
    input  logic                         lane_valid_i  [LANES],
    input  logic signed [DATA_W-1:0]     old_data_i    [LANES],
    input  logic signed [DATA_W-1:0]     partial_data_i[LANES],
    output logic                         valid_o,
    output logic signed [DATA_W-1:0]     acc_data_o    [LANES]
);

  assign valid_o = valid_i;

  always_comb begin
    acc_data_o = '{default: '0};

    for (int i = 0; i < LANES; i++) begin
      if (lane_valid_i[i]) begin
        if (first_i) begin
          acc_data_o[i] = partial_data_i[i];
        end else begin
          acc_data_o[i] = $signed(old_data_i[i]) + $signed(partial_data_i[i]);
        end
      end
    end
  end

endmodule
```

`first_i`는 현재 K tile이 첫 번째인지 나타낸다.
`first_i`가 1이면 기존 partial sum을 더하지 않고 `partial_data_i`만 저장한다.
`first_i`가 0이면 `old_data_i + partial_data_i`를 계산한다.

`lane_valid_i`는 edge N tile을 처리하기 위한 mask이다.
마지막 N tile에서 `COLS`개 lane을 모두 사용하지 못할 수 있으므로, 유효한 column lane만 누적한다.
`valid_o`는 조합 경로이기 때문에 `valid_i`를 그대로 전달한다.

accumulator에서 누적이 끝나면 다시 같은 주소에 write-back한다.

```verilog
storer_valid_o = accum_valid_i;
storer_addr_o  = acc_addr_w;
storer_data_o  = accum_data_i;
```

## Counter Update

WS FSM은 같은 `(m_idx, n_tile)`에 대해 K tile을 먼저 모두 처리한다.
K tile이 남아 있으면 `k_tile_idx_r`만 증가한다.

```verilog
if (!last_k_tile_w) begin
  k_tile_idx_r <= k_tile_idx_r + ADDR_W'(1);
end
```

마지막 K tile까지 끝나면 `k_tile_idx_r`를 0으로 되돌리고 다음 output 위치로 이동한다.
순회 순서는 `n_tile`을 먼저 증가시키고, N 방향이 끝나면 다음 `m_idx`로 넘어간다.
이때 다음 output 위치가 마지막인지도 `last_tile_r`에 미리 저장한다.

```verilog
if (!last_tile_r) begin
  if (n_tile_idx_r == n_tiles_r - ADDR_W'(1)) begin
    n_tile_idx_r <= '0;
    m_idx_r      <= m_idx_r + ADDR_W'(1);
    last_tile_r  <= (m_idx_r + ADDR_W'(1) == m_size_r - ADDR_W'(1)) &&
                    (n_tiles_r == ADDR_W'(1));
  end else begin
    n_tile_idx_r <= n_tile_idx_r + ADDR_W'(1);
    last_tile_r  <= (m_idx_r == m_size_r - ADDR_W'(1)) &&
                    (n_tile_idx_r + ADDR_W'(1) == n_tiles_r - ADDR_W'(1));
  end
end else begin
  n_tile_idx_r <= n_tile_idx_r;
  m_idx_r      <= m_idx_r;
end
```

`WAIT_ACC`와 `READ_PARTIAL`의 next-state 판단도 이 값을 사용한다.

```verilog
next_state = (last_k_tile_w && last_tile_r) ? DONE : LOAD_WEIGHT;
```

즉 마지막 K tile이면서 마지막 output 위치이면 `DONE`으로 이동하고, 그렇지 않으면 다음 K tile 또는 다음 output 위치를 위해 다시 `LOAD_WEIGHT`로 돌아간다.

즉 전체 순서는 다음과 같다.

```verilog
(m_idx 0, n_tile 0, k_tile 0)
-> (m_idx 0, n_tile 0, k_tile 1)
-> ...
-> (m_idx 0, n_tile 1, k_tile 0)
-> (m_idx 0, n_tile 1, k_tile 1)
-> ...
-> (m_idx 1, n_tile 0, k_tile 0)
```

## 주소 생성 정리

```verilog
act_loader_addr_o = act_base_addr_r + (k_tile_idx_r * m_size_r) + m_idx_r;

weight_loader_addr_o = weight_base_addr_r +
                       (((n_tile_idx_r * k_tiles_r) + k_tile_idx_r) * ROWS_W) +
                       weight_load_row_w;

acc_addr_w = acc_base_addr_r + (m_idx_r * n_tiles_r) + n_tile_idx_r;
```

세 주소식은 각각 `READ_ACT`, `LOAD_WEIGHT`, partial sum read/write-back에서 사용된다.
FSM의 역할은 이 counter 조합을 상태에 맞춰 출력하고, valid timing에 맞춰 다음 상태로 넘기는 것이다.

## 핵심 포인트

- WS FSM은 compute 전에 `LOAD_WEIGHT` 단계가 필요하다.
- `weight_load_row_w`로 weight load chain에 맞는 block 내부 read 순서를 만든다.
- `k_size_i`는 실제 K dimension이고, WS에서는 이를 `ROWS` 단위의 `k_tiles`로 나눈다.
- 첫 번째 K tile은 바로 저장하고, 이후 K tile은 기존 partial sum을 읽어 누적한다.
- `acc_addr_w`는 partial sum read와 result write-back에서 같은 주소로 사용된다.
- 전체 순회는 `(m_idx, n_tile_idx, k_tile_idx)`로 진행한다.

## systolic_array_fsm_ws.sv

```verilog
module systolic_array_fsm_ws #(
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
    // systolic_array_ws 인터페이스
    output logic signed [   ACT_W-1:0] act_o                [ROWS],
    output logic signed [WEIGHT_W-1:0] weight_o             [COLS],
    output logic                       act_valid_o          [ROWS],
    output logic                       weight_valid_o,
    input  logic                       acc_valid_i          [COLS],
    input  logic signed [   ACC_W-1:0] acc_i                [COLS],
    // bram_loader (acc partial) 인터페이스
    output logic                       acc_loader_en_o,
    output logic        [  ADDR_W-1:0] acc_loader_addr_o,
    input  logic signed [   ACC_W-1:0] acc_loader_data_i    [COLS],
    input  logic                       acc_loader_valid_i,
    // accumulator 인터페이스
    output logic                       accum_valid_o,
    output logic                       accum_first_o,
    output logic                       accum_lane_valid_o   [COLS],
    output logic signed [   ACC_W-1:0] accum_old_data_o     [COLS],
    output logic signed [   ACC_W-1:0] accum_partial_data_o [COLS],
    input  logic                       accum_valid_i,
    input  logic signed [   ACC_W-1:0] accum_data_i         [COLS],
    // bram_storer 인터페이스
    output logic                       storer_valid_o,
    output logic        [  ADDR_W-1:0] storer_addr_o,
    output logic signed [   ACC_W-1:0] storer_data_o        [COLS],
    output logic                       done_o
);

  // WS GEMM 전체 제어 FSM.
  // systolic_array_ws는 한 번에 한 output row와 COLS개 column을 계산한다.
  // K가 ROWS보다 크면 중간합을 C BRAM에 저장하고 다음 K tile에서 다시 읽어 누적한다.
  // 메모리 layout 가정:
  //   A: k_tile마다 M개의 vector word, 각 word는 ROWS개 K-lane activation
  //   B: n_tile과 k_tile마다 ROWS개의 vector word, 각 word는 COLS개 weight
  //   C: m row와 n_tile마다 1개의 vector word, 각 word는 COLS개 result/partial sum
  typedef enum logic [3:0] {
    IDLE         = 4'd0,
    LOAD_WEIGHT  = 4'd1,  // 현재 K tile의 weight를 array 내부 PE에 load
    WEIGHT_FLUSH = 4'd2,  // 1-cycle BRAM valid 지연으로 마지막 weight를 전달
    READ_ACT     = 4'd3,  // 현재 m row의 activation vector를 읽기 요청
    WAIT_ACC     = 4'd4,  // array output valid 대기
    READ_PARTIAL = 4'd5,  // C partial sum read valid 대기 및 write-back
    DONE         = 4'd6
  } state_t;

  localparam int LOAD_CNT_W = $clog2(ROWS) + 1;

  localparam logic [ADDR_W-1:0] ROWS_W = ADDR_W'(ROWS);
  localparam logic [ADDR_W-1:0] COLS_W = ADDR_W'(COLS);

  state_t state, next_state;

  logic        [    ADDR_W-1:0] m_size_r;
  logic        [    ADDR_W-1:0] n_size_r;
  logic        [    ADDR_W-1:0] k_size_r;
  logic        [    ADDR_W-1:0] act_base_addr_r;
  logic        [    ADDR_W-1:0] weight_base_addr_r;
  logic        [    ADDR_W-1:0] acc_base_addr_r;

  logic        [    ADDR_W-1:0] n_tiles_r;
  logic        [    ADDR_W-1:0] k_tiles_r;
  logic        [    ADDR_W-1:0] m_idx_r;
  logic        [    ADDR_W-1:0] n_tile_idx_r;
  logic        [    ADDR_W-1:0] k_tile_idx_r;

  logic        [LOAD_CNT_W-1:0] weight_load_cnt;
  logic signed [     ACC_W-1:0] array_acc_r        [COLS];

  logic        [    ADDR_W-1:0] n_offset_w;
  logic        [    ADDR_W-1:0] k_offset_w;
  logic        [    ADDR_W-1:0] tile_n_w;
  logic        [    ADDR_W-1:0] tile_k_w;
  logic        [    ADDR_W-1:0] acc_addr_w;
  logic        [    ADDR_W-1:0] weight_load_row_w;
  logic                         last_k_tile_w;
  logic                         last_tile_r;
  logic                         first_k_tile_w;
  logic                         all_acc_valid_w;

  assign n_offset_w = n_tile_idx_r * COLS_W;
  assign k_offset_w = k_tile_idx_r * ROWS_W;
  assign tile_n_w = min_const(n_size_r - n_offset_w, COLS_W);
  assign tile_k_w = min_const(k_size_r - k_offset_w, ROWS_W);
  assign acc_addr_w = acc_base_addr_r + (m_idx_r * n_tiles_r) + n_tile_idx_r;
  assign weight_load_row_w = (ROWS_W - ADDR_W'(1)) - ADDR_W'(weight_load_cnt);
  assign first_k_tile_w = (k_tile_idx_r == '0);
  assign last_k_tile_w = (k_tile_idx_r == k_tiles_r - ADDR_W'(1));

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

  always_comb begin
    all_acc_valid_w = 1'b1;
    for (int c = 0; c < COLS; c++) begin
      all_acc_valid_w = all_acc_valid_w && acc_valid_i[c];
    end
  end

  always_comb begin
    accum_lane_valid_o = '{default: 1'b0};
    for (int c = 0; c < COLS; c++) begin
      accum_lane_valid_o[c] = (ADDR_W'(c) < tile_n_w);
    end
  end

  always_comb begin
    accum_valid_o        = 1'b0;
    accum_first_o        = first_k_tile_w;
    accum_old_data_o     = '{default: '0};
    accum_partial_data_o = '{default: '0};

    if ((state == WAIT_ACC) && all_acc_valid_w && first_k_tile_w) begin
      accum_valid_o = 1'b1;
      for (int c = 0; c < COLS; c++) begin
        accum_partial_data_o[c] = acc_i[c];
      end
    end else if ((state == READ_PARTIAL) && acc_loader_valid_i) begin
      accum_valid_o = 1'b1;
      for (int c = 0; c < COLS; c++) begin
        accum_old_data_o[c]     = acc_loader_data_i[c];
        accum_partial_data_o[c] = array_acc_r[c];
      end
    end
  end

  always_ff @(posedge aclk_i) begin
    if (!aresetn_i) state <= IDLE;
    else state <= next_state;
  end

  always_comb begin
    next_state = state;
    case (state)
      IDLE: begin
        if (start_i && (m_size_i != '0) && (n_size_i != '0) && (k_size_i != '0)) begin
          next_state = LOAD_WEIGHT;
        end else if (start_i) begin
          next_state = DONE;
        end
      end

      LOAD_WEIGHT: begin
        if (weight_load_cnt == LOAD_CNT_W'(ROWS - 1)) next_state = WEIGHT_FLUSH;
      end

      WEIGHT_FLUSH: begin
        next_state = READ_ACT;
      end

      READ_ACT: begin
        next_state = WAIT_ACC;
      end

      WAIT_ACC: begin
        if (all_acc_valid_w) begin
          if (first_k_tile_w) begin
            next_state = (last_k_tile_w && last_tile_r) ? DONE : LOAD_WEIGHT;
          end else begin
            next_state = READ_PARTIAL;
          end
        end
      end

      READ_PARTIAL: begin
        if (acc_loader_valid_i) begin
          next_state = (last_k_tile_w && last_tile_r) ? DONE : LOAD_WEIGHT;
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
      n_tiles_r          <= '0;
      k_tiles_r          <= '0;
      m_idx_r            <= '0;
      n_tile_idx_r       <= '0;
      k_tile_idx_r       <= '0;
      weight_load_cnt    <= '0;
      array_acc_r        <= '{default: '0};
      last_tile_r        <= 1'b0;
    end else begin
      case (state)
        IDLE: begin
          m_idx_r         <= '0;
          n_tile_idx_r    <= '0;
          k_tile_idx_r    <= '0;
          weight_load_cnt <= '0;
          array_acc_r     <= '{default: '0};
          last_tile_r     <= 1'b0;

          if (start_i) begin
            m_size_r           <= m_size_i;
            n_size_r           <= n_size_i;
            k_size_r           <= k_size_i;
            act_base_addr_r    <= act_base_addr_i;
            weight_base_addr_r <= weight_base_addr_i;
            acc_base_addr_r    <= acc_base_addr_i;
            n_tiles_r          <= ceil_div_const(n_size_i, COLS_W);
            k_tiles_r          <= ceil_div_const(k_size_i, ROWS_W);
            last_tile_r        <= (m_size_i == ADDR_W'(1)) &&
                                  (ceil_div_const(n_size_i, COLS_W) == ADDR_W'(1));
          end
        end

        LOAD_WEIGHT: begin
          if (weight_load_cnt == LOAD_CNT_W'(ROWS - 1)) begin
            weight_load_cnt <= '0;
          end else begin
            weight_load_cnt <= weight_load_cnt + LOAD_CNT_W'(1);
          end
        end

        WAIT_ACC: begin
          if (all_acc_valid_w) begin
            for (int c = 0; c < COLS; c++) begin
              array_acc_r[c] <= acc_i[c];
            end

            if (first_k_tile_w) begin
              if (!last_k_tile_w) begin
                k_tile_idx_r <= k_tile_idx_r + ADDR_W'(1);
              end else begin
                k_tile_idx_r <= '0;

                if (!last_tile_r) begin
                  if (n_tile_idx_r == n_tiles_r - ADDR_W'(1)) begin
                    n_tile_idx_r <= '0;
                    m_idx_r      <= m_idx_r + ADDR_W'(1);
                    last_tile_r  <= (m_idx_r + ADDR_W'(1) == m_size_r - ADDR_W'(1)) &&
                                    (n_tiles_r == ADDR_W'(1));
                  end else begin
                    n_tile_idx_r <= n_tile_idx_r + ADDR_W'(1);
                    last_tile_r  <= (m_idx_r == m_size_r - ADDR_W'(1)) &&
                                    (n_tile_idx_r + ADDR_W'(1) == n_tiles_r - ADDR_W'(1));
                  end
                end
              end
            end
          end
        end

        READ_PARTIAL: begin
          if (acc_loader_valid_i) begin
            if (!last_k_tile_w) begin
              k_tile_idx_r <= k_tile_idx_r + ADDR_W'(1);
            end else begin
              k_tile_idx_r <= '0;

              if (!last_tile_r) begin
                if (n_tile_idx_r == n_tiles_r - ADDR_W'(1)) begin
                  n_tile_idx_r <= '0;
                  m_idx_r      <= m_idx_r + ADDR_W'(1);
                  last_tile_r  <= (m_idx_r + ADDR_W'(1) == m_size_r - ADDR_W'(1)) &&
                                  (n_tiles_r == ADDR_W'(1));
                end else begin
                  n_tile_idx_r <= n_tile_idx_r + ADDR_W'(1);
                  last_tile_r  <= (m_idx_r == m_size_r - ADDR_W'(1)) &&
                                  (n_tile_idx_r + ADDR_W'(1) == n_tiles_r - ADDR_W'(1));
                end
              end else begin
                n_tile_idx_r <= n_tile_idx_r;
                m_idx_r      <= m_idx_r;
              end
            end
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
      acc_loader_en_o      <= 1'b0;
      acc_loader_addr_o    <= '0;
      done_o               <= 1'b0;
    end else begin
      act_loader_en_o    <= 1'b0;
      weight_loader_en_o <= 1'b0;
      acc_loader_en_o    <= 1'b0;
      done_o             <= 1'b0;

      case (state)
        LOAD_WEIGHT: begin
          weight_loader_en_o <= 1'b1;
          weight_loader_addr_o <= weight_base_addr_r +
                                  (((n_tile_idx_r * k_tiles_r) + k_tile_idx_r) * ROWS_W) +
                                  weight_load_row_w;
        end

        READ_ACT: begin
          act_loader_en_o   <= 1'b1;
          act_loader_addr_o <= act_base_addr_r + (k_tile_idx_r * m_size_r) + m_idx_r;
        end

        WAIT_ACC: begin
          if (all_acc_valid_w && !first_k_tile_w) begin
            acc_loader_en_o   <= 1'b1;
            acc_loader_addr_o <= acc_addr_w;
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
    storer_valid_o = accum_valid_i;
    storer_addr_o  = '0;
    storer_data_o  = '{default: '0};

    if (accum_valid_i) begin
      storer_addr_o = acc_addr_w;
      storer_data_o = accum_data_i;
    end
  end

  always_comb begin
    weight_o       = weight_loader_data_i;
    weight_valid_o = 1'b0;
    act_o          = '{default: '0};
    act_valid_o    = '{default: 1'b0};

    if ((state == LOAD_WEIGHT) || (state == WEIGHT_FLUSH) || (state == READ_ACT)) begin
      weight_valid_o = weight_loader_valid_i;
    end

    for (int r = 0; r < ROWS; r++) begin
      if (ADDR_W'(r) < tile_k_w) begin
        act_o[r] = act_loader_data_i[r];
      end else begin
        act_o[r] = '0;
      end

      // edge K에서도 valid chain이 끊기지 않도록 0 data를 valid로 흘린다.
      act_valid_o[r] = act_loader_valid_i;
    end
  end

endmodule
```
