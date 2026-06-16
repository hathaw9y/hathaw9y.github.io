---
title: Systolic Array Engine 설계
date: 2026-06-14 18:30:00 +0900
series: Systolic Array
series_order: 9
categories: Hardware
subcategory: RTL
tags:
  - SystemVerilog
  - Systolic_Array
---
## 개요

이제 앞에서 만든 모듈들을 하나로 연결해 **Systolic Array Engine**을 구성한다.

지금까지는 PE, Systolic Array, BRAM Loader/Store, FSM을 각각 따로 보았다.
하지만 실제로 Controller가 사용하는 단위는 이 개별 모듈들이 아니라, 이들을 모두 감싼 하나의 top-level block이다.

```text
Controller
  -> Systolic Array Engine
      -> BRAM Loader
      -> Systolic Array FSM
      -> Systolic Array
      -> BRAM Storer
```

Engine은 외부에서 보면 단순하다.

- `start_i`를 받는다
- `m_size_i`, `n_size_i`, `k_size_i`를 받는다
- Activation, Weight, Accumulator BRAM의 base address를 받는다
- BRAM read/write port를 통해 데이터를 주고받는다
- 연산이 끝나면 `done_o`를 낸다

반대로 Engine 내부에서는 여러 모듈이 서로 valid/data/address 신호를 주고받는다.
즉 Engine의 역할은 **외부 Controller와 내부 compute datapath 사이의 경계**를 만드는 것이다.

이 시리즈 전체를 기준으로 보면 설계는 Top-Down으로 시작했다.
먼저 Engine이 어떤 역할을 해야 하는지 정하고, 그 안을 FSM, Loader, Array, Storer로 나누었다.
구현은 반대로 Bottom-Up으로 진행했다.
작은 PE부터 만들고, Array를 만들고, 메모리 인터페이스와 FSM을 붙인 뒤, 마지막에 Engine에서 모두 연결한다.

## 공통 인터페이스

OS Engine과 WS Engine은 dataflow는 다르지만, 기본적인 입력 설정은 같다.

```verilog
input logic               start_i,
input logic [ADDR_W-1:0]  m_size_i,
input logic [ADDR_W-1:0]  n_size_i,
input logic [ADDR_W-1:0]  k_size_i,
input logic [ADDR_W-1:0]  act_base_addr_i,
input logic [ADDR_W-1:0]  weight_base_addr_i,
input logic [ADDR_W-1:0]  acc_base_addr_i,
output logic              done_o
```

`m_size_i`, `n_size_i`, `k_size_i`는 실제 GEMM 크기다.

$$C_{M \times N} = A_{M \times K} \times B_{K \times N}$$

따라서 FSM은 이 값을 기준으로 tile 개수와 edge tile의 valid mask를 계산한다.
base address는 각 행렬이 BRAM에서 시작하는 위치다.
Engine 내부에서는 이 base address에 현재 tile index를 더해 실제 BRAM 주소를 만든다.

## OS Engine

Output Stationary 방식에서는 출력 partial sum이 PE 내부에 머문다.
따라서 OS Engine의 데이터 경로는 비교적 단순하다.

```text
BRAM_A -> act_loader ----\
                         -> systolic_array_os -> bram_storer -> BRAM_C
BRAM_B -> weight_loader -/
```

FSM은 Activation/Weight Loader를 제어하고, Systolic Array에 valid를 공급하며, 계산이 끝난 tile을 Storer로 넘긴다.

OS Engine 내부 모듈은 다음과 같다.

| 모듈 | 역할 |
|---|---|
| `bram_loader (act)` | Activation BRAM에서 `ROWS`개 activation vector 읽기 |
| `bram_loader (weight)` | Weight BRAM에서 `COLS`개 weight vector 읽기 |
| `systolic_array_fsm_os` | tile 순회, 주소 생성, clear/compute/drain/store 제어 |
| `systolic_array_os` | PE 내부 accumulator에 output stationary 방식으로 누적 |
| `bram_storer` | 계산된 C tile을 BRAM_C에 저장 |

### Loader 연결

Activation loader는 한 cycle에 `ROWS`개 데이터를 내보낸다.

```verilog
bram_loader #(
    .ROWS  (ROWS),
    .DATA_W(ACT_W),
    .BRAM_W(ROWS * ACT_W),
    .ADDR_W(ADDR_W)
) u_act_loader (
    .en_i       (act_loader_en_w),
    .addr_i     (act_loader_addr_w),
    .bram_en_o  (act_bram_en_o),
    .bram_addr_o(act_bram_addr_o),
    .bram_data_i(act_bram_data_i),
    .data_o     (act_loader_data_w),
    .valid_o    (act_loader_valid_w)
);
```

Weight loader는 한 cycle에 `COLS`개 데이터를 내보낸다.

```verilog
bram_loader #(
    .ROWS  (COLS),
    .DATA_W(WEIGHT_W),
    .BRAM_W(COLS * WEIGHT_W),
    .ADDR_W(ADDR_W)
) u_weight_loader (
    .en_i       (weight_loader_en_w),
    .addr_i     (weight_loader_addr_w),
    .bram_en_o  (weight_bram_en_o),
    .bram_addr_o(weight_bram_addr_o),
    .bram_data_i(weight_bram_data_i),
    .data_o     (weight_loader_data_w),
    .valid_o    (weight_loader_valid_w)
);
```

여기서 `bram_loader` 자체는 act/weight를 구분하지 않는다.
몇 개의 lane을 읽을지, lane당 data width가 얼마인지만 parameter로 달라진다.
실제 주소 순서는 FSM이 만든다.

### FSM과 Array 연결

OS FSM은 loader에서 받은 데이터를 array 입력으로 넘긴다.

```verilog
systolic_array_fsm_os u_fsm (
    .act_loader_en_o      (act_loader_en_w),
    .act_loader_addr_o    (act_loader_addr_w),
    .act_loader_data_i    (act_loader_data_w),
    .act_loader_valid_i   (act_loader_valid_w),

    .weight_loader_en_o   (weight_loader_en_w),
    .weight_loader_addr_o (weight_loader_addr_w),
    .weight_loader_data_i (weight_loader_data_w),
    .weight_loader_valid_i(weight_loader_valid_w),

    .act_o                (act_w),
    .weight_o             (weight_w),
    .act_valid_o          (act_valid_w),
    .weight_valid_o       (weight_valid_w),
    .acc_clear_o          (acc_clear_w),
    .acc_i                (array_acc_w)
);
```

`systolic_array_os`는 이 신호를 받아 PE 내부 accumulator에 결과를 누적한다.

```verilog
systolic_array_os u_array (
    .act_i         (act_w),
    .weight_i      (weight_w),
    .act_valid_i   (act_valid_w),
    .weight_valid_i(weight_valid_w),
    .acc_clear_i   (acc_clear_w),
    .acc_o         (array_acc_w)
);
```

OS에서 중요한 신호는 `acc_clear_w`다.
Output Stationary는 PE 내부에 이전 tile의 누적값이 남을 수 있으므로, 새로운 output tile을 시작하기 전에 accumulator를 clear해야 한다.
FSM은 `CLEAR` 상태에서 이 신호를 1 cycle 동안 assert한다.

### Store 연결

OS Array의 출력은 `array_acc_w[ROWS][COLS]` 형태다.
FSM은 이 중 한 column씩 선택해서 `storer_data_w[ROWS]`로 만든다.
즉 BRAM_C에는 한 주소당 `ROWS`개 output value가 packed되어 저장된다.

```verilog
bram_storer #(
    .LANES (ROWS),
    .DATA_W(ACC_W),
    .BRAM_W(ROWS * ACC_W),
    .ADDR_W(ADDR_W)
) u_acc_storer (
    .valid_i    (storer_valid_w),
    .addr_i     (storer_addr_w),
    .data_i     (storer_data_w),
    .bram_en_o  (acc_bram_en_o),
    .bram_we_o  (acc_bram_we_o),
    .bram_addr_o(acc_bram_addr_o),
    .bram_data_o(acc_bram_data_o)
);
```

정리하면 OS Engine에서는 C BRAM을 읽을 필요가 없다.
하나의 output tile에 대한 K 방향 누적은 PE 내부에서 끝나고, 마지막에 완성된 값을 저장하기 때문이다.

## WS Engine

Weight Stationary 방식은 OS보다 Engine 연결이 조금 더 복잡하다.
Weight는 PE 내부에 고정되지만, K tile이 여러 개라면 partial sum을 BRAM_C에 저장했다가 다시 읽어 누적해야 한다.

```text
BRAM_A -> act_loader ----\
                         -> systolic_array_ws -> accumulator -> bram_storer -> BRAM_C write
BRAM_B -> weight_loader -/                         ^
                                                    |
BRAM_C read -> acc_loader -------------------------/
```

WS Engine 내부 모듈은 다음과 같다.

| 모듈 | 역할 |
|---|---|
| `bram_loader (act)` | 현재 `m_idx`, `k_tile`에 해당하는 activation vector 읽기 |
| `bram_loader (weight)` | 현재 `n_tile`, `k_tile`에 해당하는 weight block 읽기 |
| `systolic_array_fsm_ws` | weight load, activation read, partial sum read/store 제어 |
| `systolic_array_ws` | PE 내부에 weight를 고정하고 activation을 흘려 MAC 수행 |
| `bram_loader (acc)` | 이전 K tile까지의 partial sum 읽기 |
| `accumulator` | 이전 partial sum과 새 partial sum 누적 |
| `bram_storer` | 누적 결과를 BRAM_C에 다시 저장 |

### Accumulator 경로

WS Engine에서 OS와 가장 크게 달라지는 부분은 accumulator 경로다.

```verilog
bram_loader #(
    .ROWS  (COLS),
    .DATA_W(ACC_W),
    .BRAM_W(COLS * ACC_W),
    .ADDR_W(ADDR_W)
) u_acc_loader (
    .en_i       (acc_loader_en_w),
    .addr_i     (acc_loader_addr_w),
    .bram_en_o  (acc_rd_bram_en_o),
    .bram_addr_o(acc_rd_bram_addr_o),
    .bram_data_i(acc_rd_bram_data_i),
    .data_o     (acc_loader_data_w),
    .valid_o    (acc_loader_valid_w)
);
```

`systolic_array_ws`의 출력은 한 번에 `COLS`개 partial sum이다.
첫 번째 K tile이면 이 값을 그대로 저장하면 된다.
하지만 두 번째 K tile부터는 BRAM_C에 저장되어 있던 기존 partial sum을 읽어와야 한다.

```verilog
accumulator #(
    .LANES (COLS),
    .DATA_W(ACC_W)
) u_accumulator (
    .valid_i       (accum_valid_w),
    .first_i       (accum_first_w),
    .lane_valid_i  (accum_lane_valid_w),
    .old_data_i    (accum_old_data_w),
    .partial_data_i(accum_partial_data_w),
    .valid_o       (accum_result_valid_w),
    .acc_data_o    (accum_result_data_w)
);
```

`first_i`가 1이면 이전 partial sum이 없으므로 `partial_data_i`를 그대로 통과시킨다.
`first_i`가 0이면 BRAM_C에서 읽은 `old_data_i`와 array가 만든 `partial_data_i`를 더한다.

따라서 WS Engine은 C BRAM에 대해 read path와 write path를 모두 가진다.

```verilog
output logic              acc_rd_bram_en_o,
output logic [ADDR_W-1:0] acc_rd_bram_addr_o,
input  logic [COLS*ACC_W-1:0] acc_rd_bram_data_i,

output logic              acc_wr_bram_en_o,
output logic              acc_wr_bram_we_o,
output logic [ADDR_W-1:0] acc_wr_bram_addr_o,
output logic [COLS*ACC_W-1:0] acc_wr_bram_data_o
```

이 구조 덕분에 WS Array 자체는 현재 K tile의 partial sum만 만들고, 여러 K tile에 대한 누적은 Engine 안의 accumulator 경로가 담당한다.

## OS와 WS Engine 비교

두 Engine의 차이를 정리하면 다음과 같다.

| 항목 | OS Engine | WS Engine |
|---|---|---|
| Array 출력 | `ROWS x COLS` tile | `COLS`개 partial sum |
| C BRAM 접근 | write만 사용 | read/write 모두 사용 |
| partial sum 위치 | PE 내부 accumulator | BRAM_C + accumulator |
| 추가 모듈 | 없음 | `acc_loader`, `accumulator` |
| store lane 수 | `ROWS` | `COLS` |
| 주요 제어 | clear, compute, drain, store | weight load, activation read, partial sum read/write |

OS는 output tile 하나를 PE 내부에서 끝까지 완성한 뒤 저장한다.
반면 WS는 weight를 먼저 고정하고 activation을 흘리며 row 단위 partial sum을 만든다.
K tile이 바뀌면 이전 partial sum과 새 partial sum을 더해야 하므로 C BRAM을 다시 읽는 경로가 필요하다.

## Engine의 의미

Engine을 만들고 나면 외부 Controller는 내부 모듈의 세부 timing을 알 필요가 없다.
Controller는 다음 정보만 넘기면 된다.

```text
start
M, N, K size
Activation base address
Weight base address
Accumulator base address
```

그 이후에는 Engine 내부 FSM이 memory layout에 맞는 주소를 만들고, Loader가 BRAM word를 lane 배열로 바꾸고, Systolic Array가 MAC을 수행하고, Storer가 결과를 다시 BRAM word로 묶는다.

즉 `systolic_array_engine_os`와 `systolic_array_engine_ws`는 지금까지 만든 모든 하위 모듈을 실제로 사용할 수 있는 형태로 묶는 최종 wrapper다.

이 단계까지 오면 Systolic Array는 더 이상 독립적인 PE 배열이 아니다.
외부 Controller가 시작시키고, BRAM을 통해 데이터를 주고받으며, `done_o`로 종료를 알리는 하나의 가속기 block이 된다.
