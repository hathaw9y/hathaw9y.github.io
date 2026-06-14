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

앞서 구현한 모듈들을 하나로 연결하고 제어하는 FSM을 설계한다.

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

```systemverilog
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

```systemverilog
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

```systemverilog
m_size_r           <= m_size_i;
n_size_r           <= n_size_i;
k_size_r           <= k_size_i;
act_base_addr_r    <= act_base_addr_i;
weight_base_addr_r <= weight_base_addr_i;
acc_base_addr_r    <= acc_base_addr_i;
```

동시에 M/N 방향 tile 개수를 계산한다.

```systemverilog
m_tiles_r <= ceil_div_const(m_size_i, ROWS_W);
n_tiles_r <= ceil_div_const(n_size_i, COLS_W);
k_last_r  <= (k_size_i == '0) ? '0 : k_size_i - ADDR_W'(1);
```

`M`, `N`, `K` 중 하나라도 0이면 연산할 것이 없으므로 바로 `DONE`으로 이동한다.
정상 입력이면 `CLEAR`로 이동한다.

#### CLEAR

Output Stationary에서는 각 PE 내부 accumulator에 부분합이 남는다.
따라서 새 tile 계산을 시작하기 전에 accumulator를 clear해야 한다.

```systemverilog
acc_clear_o <= 1'b1;
```

`CLEAR`는 1 cycle pulse로 동작하고 다음 상태는 `COMPUTE`이다.

#### COMPUTE

`COMPUTE` 상태에서는 현재 tile의 A/B vector word를 K 방향으로 stream한다.

```systemverilog
act_loader_en_o      <= 1'b1;
act_loader_addr_o    <= act_base_addr_r + (m_tile_idx_r * k_size_r) + k_cnt;

weight_loader_en_o   <= 1'b1;
weight_loader_addr_o <= weight_base_addr_r + (n_tile_idx_r * k_size_r) + k_cnt;
```

여기서 `k_cnt`는 현재 tile 안에서 읽고 있는 K offset이다.
`k_cnt == k_last_r`이 되면 더 이상 읽을 K 데이터가 없으므로 `DRAIN`으로 넘어간다.

loader에서 읽은 데이터는 systolic array 입력으로 바로 연결한다.

```systemverilog
act_o    = act_loader_data_i;
weight_o = weight_loader_data_i;
```

단, edge tile에서는 `ROWS` 또는 `COLS`를 꽉 채우지 못할 수 있다.
예를 들어 `M = 30`, `ROWS = 16`이면 마지막 M tile에는 유효 row가 14개뿐이다.
따라서 valid 신호를 row/column 단위로 masking한다.

```systemverilog
for (int r = 0; r < ROWS; r++) begin
  act_valid_o[r] = act_loader_valid_i && (ADDR_W'(r) < tile_m_w);
end

for (int c = 0; c < COLS; c++) begin
  weight_valid_o[c] = weight_loader_valid_i && (ADDR_W'(c) < tile_n_w);
end
```

현재 tile에서 실제로 유효한 row/column 수는 아래처럼 계산한다.

```systemverilog
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

```systemverilog
localparam int DRAIN_LAST = ROWS + COLS - 2;
```

`drain_cnt == DRAIN_LAST_W`가 되면 `STORE`로 이동한다.

#### STORE

`STORE` 상태에서는 output tile을 column 단위로 저장한다.
한 주소에는 같은 column에 속한 `ROWS`개 result가 들어간다.

```systemverilog
storer_valid_o <= 1'b1;
storer_addr_o  <= acc_base_addr_r + (tile_linear_idx_w * COLS_W) + ADDR_W'(store_cnt);
```

`acc_i`는 `[row][col]` 형태이므로, 현재 저장할 column은 `store_col_idx`로 선택한다.

```systemverilog
for (int r = 0; r < ROWS; r++) begin
  if (ADDR_W'(r) < tile_m_w) begin
    storer_data_o[r] <= acc_i[r][store_col_idx];
  end
end
```

edge tile에서는 유효 row만 저장한다.
또한 마지막 N tile에서는 유효 column 수가 `COLS`보다 작을 수 있으므로 `tile_n_last_w`까지만 store한다.

```systemverilog
if (store_cnt == STORE_CNT_W'(tile_n_last_w)) begin
  next_state = last_tile_w ? DONE : CLEAR;
end
```

현재 tile 저장이 끝나면 다음 tile로 이동한다.
순회 순서는 N tile을 먼저 증가시키고, N 방향이 끝나면 다음 M tile로 넘어간다.

```systemverilog
if (n_tile_idx_r == n_tiles_r - ADDR_W'(1)) begin
  n_tile_idx_r <= '0;
  m_tile_idx_r <= m_tile_idx_r + ADDR_W'(1);
end else begin
  n_tile_idx_r <= n_tile_idx_r + ADDR_W'(1);
end
```

#### DONE

마지막 tile까지 모두 저장하면 `DONE` 상태에서 `done_o`를 1 cycle pulse로 출력한다.

```systemverilog
done_o <= 1'b1;
```

다음 cycle에는 다시 `IDLE`로 복귀한다.

## 주소 계산 정리

### A 주소

```systemverilog
act_loader_addr_o = act_base_addr_r + (m_tile_idx_r * k_size_r) + k_cnt;
```

A는 M tile 기준으로 K 방향 vector word를 순서대로 읽는다.

### B 주소

```systemverilog
weight_loader_addr_o = weight_base_addr_r + (n_tile_idx_r * k_size_r) + k_cnt;
```

B는 N tile 기준으로 K 방향 vector word를 순서대로 읽는다.

### C 주소

```systemverilog
tile_linear_idx_w = (m_tile_idx_r * n_tiles_r) + n_tile_idx_r;
storer_addr_o = acc_base_addr_r + (tile_linear_idx_w * COLS_W) + store_cnt;
```

C는 tile을 row-major 순서로 배치하고, 각 tile 내부에서는 column 단위로 저장한다.

## 핵심 포인트

- `CLEAR` 상태를 따로 두어 OS accumulator를 tile마다 초기화한다.
- `COMPUTE`는 K 방향 stream만 담당한다.
- `DRAIN`은 systolic array 내부 latency를 보상한다.
- `STORE`는 `acc_i[row][col]`에서 column을 선택해 BRAM에 쓴다.
- edge tile에서는 `tile_m_w`, `tile_n_w`로 valid와 store 범위를 masking한다.
- 전체 GEMM은 `(m_tile_idx_r, n_tile_idx_r)`를 순회하며 처리한다.
