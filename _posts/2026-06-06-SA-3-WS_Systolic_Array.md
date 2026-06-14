---
title: WS Systolic Array 설계
date: 2026-06-06 10:00:00 +0900
series: Systolic Array
series_order: 3
categories: Hardware
subcategory: RTL
tags:
  - SystemVerilog
  - Systolic_Array
---
## Weight Stationary란?

Weight Stationary(WS)는 **weight를 PE 안에 고정**하는 dataflow이다.

행렬 곱셈은 다음처럼 계산된다.

$$C_{i,j} = \sum_k A_{i,k} \times B_{k,j}$$

OS에서는 PE가 `C[i][j]`의 부분합을 들고 있었다.
반면 WS에서는 PE가 출력값이 아니라 **weight**를 들고 있는다.

예를 들어 PE `(row, col)`은 연산 전에 자신이 사용할 weight를 내부 register에 저장한다.
그 뒤 activation이 왼쪽에서 들어오면, 저장해 둔 weight와 곱하고 위에서 내려온 partial sum에 더해 아래로 보낸다.

따라서 데이터 흐름은 다음처럼 정해진다.

- `weight` (가중치 행렬 B): PE 안에 고정, 이동하지 않음
- `activation` (입력 행렬 A의 행): 왼쪽 → 오른쪽으로 흐름
- `acc` (부분합): 위 → 아래로 흐름

OS와의 핵심 차이는 **acc가 PE 밖으로 흘러나간다**는 점이다.
weight를 한 번 로드하면 여러 activation에 재사용할 수 있어, 동일한 가중치로 반복 연산하는 LLM 추론에 유리하다.

![](/assets/images/Pasted%20image%2020260606155222.png)

핵심은 `weight_reg`이다.
PE는 weight를 내부 register에 저장하고, 이후 compute 단계에서는 그 값을 계속 재사용한다.

```text
PE(row, col)
  weight_reg <= weight_i
  acc_o      <= acc_i + act_i * weight_reg
```

이 구조에서는 output partial sum이 PE 내부에 머무르지 않는다.
대신 위쪽 PE에서 내려온 `acc_i`에 현재 PE의 MAC 결과를 더한 뒤, 아래쪽 PE로 `acc_o`를 전달한다.

## PE 구현

### PE가 하는 일
![](assets/images/Pasted%20image%2020260606155222.png)
WS에서 PE는 **weight를 내부 레지스터에 고정**한다.

PE 하나가 하는 일은 다음과 같다.

1. 위쪽에서 `weight_i`를 받는다.
2. `weight_valid_i`가 1이면 `weight_i`를 `weight_reg`에 저장한다.
3. 왼쪽에서 `act_i`를 받는다.
4. 위쪽에서 `acc_i`를 받는다.
5. activation과 acc가 모두 유효하면 `act_i * weight_reg + acc_i`를 계산한다.
6. activation은 오른쪽으로, weight와 acc는 아래쪽으로 전달한다.

OS PE와 비교하면 가장 큰 차이는 accumulator의 위치다.

| Dataflow | PE 내부에 고정되는 값 | 아래로 흐르는 값 |
|---|---|---|
| OS | `acc` | `weight` |
| WS | `weight` | `acc` |

### Weight load와 compute

WS는 compute 전에 weight load 단계가 필요하다.
이 단계에서 각 PE는 자신이 사용할 weight를 `weight_reg`에 저장한다.

```systemverilog
if (weight_valid_i) begin
  weight_reg <= weight_i;
end
```

그 다음 compute 단계에서는 저장된 `weight_reg`를 사용한다.

```systemverilog
if (act_valid_i && acc_valid_i) begin
  acc_o <= $signed(act_i) * $signed(weight_reg) + $signed(acc_i);
end
```

`acc_valid_i`가 필요한 이유는 부분합이 위쪽에서 내려오는 값이기 때문이다.
activation만 유효하더라도 위쪽 partial sum이 아직 도착하지 않았다면 올바른 누산을 할 수 없다.

### PE 포트 설계

| 포트               | 방향     | 비트폭      | 설명                    |
| ---------------- | ------ | -------- | --------------------- |
| `aclk_i`         | input  | 1-bit    | 클락                    |
| `aresetn_i`      | input  | 1-bit    | 액티브 로우 리셋             |
| `act_valid_i`    | input  | 1-bit    | activation 유효 신호      |
| `weight_valid_i` | input  | 1-bit    | weight 저장 신호          |
| `acc_valid_i`    | input  | 1-bit    | acc 유효 신호             |
| `act_i`          | input  | ACT_W    | 왼쪽에서 들어오는 activation  |
| `weight_i`       | input  | WEIGHT_W | 로드할 weight 값          |
| `acc_i`          | input  | ACC_W    | 위에서 들어오는 부분합          |
| `act_valid_o`    | output | 1-bit    | 오른쪽 PE로 유효 신호 전달      |
| `acc_valid_o`    | output | 1-bit    | 아래 PE로 유효 신호 전달       |
| `act_o`          | output | ACT_W    | 오른쪽 PE로 activation 전달 |
| `weight_o`       | output | WEIGHT_W | 아래 PE로 weight 전달      |
| `acc_o`          | output | ACC_W    | 아래 PE로 부분합 전달         |

### pe_ws.sv

```SystemVerilog
module pe_ws #(
    parameter int ACT_W    = 8,   // activation 비트폭
    parameter int WEIGHT_W = 8,   // weight 비트폭
    parameter int ACC_W    = 32   // 누산기 비트폭 (오버플로우 방지)
) (
    input  logic                       aclk_i,          // 클락
    input  logic                       aresetn_i,       // 액티브 로우 리셋
    input  logic                       act_valid_i,     // activation 유효 신호
    input  logic                       weight_valid_i,  // weight 유효 신호
    input  logic                       acc_valid_i,     // acc 유효 신호
    input  logic signed [   ACT_W-1:0] act_i,           // 왼쪽 PE에서 전달된 activation
    input  logic signed [WEIGHT_W-1:0] weight_i,        // 위쪽 PE에서 전달된 weight
    input  logic signed [   ACC_W-1:0] acc_i,           // 위쪽 PE에서 전달된 부분합
    output logic                       act_valid_o,     // 오른쪽 PE로 유효 신호 전달
    output logic                       acc_valid_o,     // 아래쪽 PE로 유효 신호 전달
    output logic signed [   ACT_W-1:0] act_o,           // 오른쪽 PE로 activation 전달
    output logic signed [WEIGHT_W-1:0] weight_o,        // 아래쪽 PE로 weight 전달
    output logic signed [   ACC_W-1:0] acc_o            // 누산 결과 출력
);
  logic signed [WEIGHT_W-1:0] weight_reg;  // weight 레지스터

  always_ff @(posedge aclk_i) begin
    if (!aresetn_i) begin
      act_valid_o <= 0;
      acc_valid_o <= 0;
      act_o       <= 0;
      weight_o    <= 0;
      acc_o       <= 0;
      weight_reg  <= 0;
    end else begin
      if (weight_valid_i) begin
        weight_reg <= weight_i;  // weight는 위쪽 PE에서 1클락 지연 저장
      end
      // 신호 및 데이터를 인접 PE로 1클락 지연 전파
      act_valid_o <= act_valid_i;
      acc_valid_o <= act_valid_i && acc_valid_i;  // 양쪽 valid일 때만 acc 유효
      act_o       <= act_i;
      weight_o    <= weight_i;
      if (act_valid_i && acc_valid_i) begin
        acc_o <= $signed(act_i) * $signed(weight_reg) + $signed(acc_i);  // 누산
      end else begin
        acc_o <= acc_i;
      end
    end
  end
endmodule

```

## Systolic Array 구현

### PE를 2D로 연결하기

WS 배열도 `ROWS x COLS`개의 PE를 2D grid로 배치한다.
하지만 OS와 달리 각 PE가 output element를 끝까지 들고 있지 않는다.
각 column의 partial sum이 위에서 아래로 흐르며 누산되고, 최종 결과는 배열의 맨 아래에서 나온다.

WS 배열에서 입력 신호는 다음과 같이 전달된다.

- `act_i[row]`: 각 행의 왼쪽 끝 PE로 입력, 오른쪽으로 전파
- `weight_i[col]`: 각 열의 위쪽 끝 PE로 입력, 아래로 전파되며 각 PE의 `weight_reg`에 저장
- `acc_wire[0][col]`: 각 column의 초기 partial sum이며 0으로 시작
- `acc_o[col]`: 배열 맨 아래에서 나오는 최종 partial sum

OS와 달리 연산 전 **weight 로드 단계**가 선행되어야 한다.

```text
act_i[0] -> PE(0,0) -> PE(0,1) -> ... -> PE(0,COLS-1)
act_i[1] -> PE(1,0) -> PE(1,1) -> ... -> PE(1,COLS-1)
...

acc = 0  ↓ PE(0,0) ↓ PE(1,0) ↓ ... ↓ PE(ROWS-1,0) -> acc_o[0]
acc = 0  ↓ PE(0,1) ↓ PE(1,1) ↓ ... ↓ PE(ROWS-1,1) -> acc_o[1]
```

즉 activation은 row 방향으로 흐르고, partial sum은 column 방향으로 흐른다.
weight도 column 방향으로 전달되지만, compute에 사용할 값은 각 PE 내부의 `weight_reg`에 고정된다.

### Weight 로드 단계

연산 전 각 PE에 weight를 로드한다.
현재 코드에서는 `weight_i[col]`이 위에서 아래로 전달되고, `weight_valid_i`가 켜진 cycle에 각 PE가 입력 weight를 저장한다.

- `weight_i/o`로 weight를 전달
- weight가 자신의 PE에 도착했을 때 `weight_valid_i`를 활성화
- 각 PE는 그 시점의 `weight_i`를 `weight_reg`에 저장

### 연산 단계

매 클락마다 각 PE는 고정된 `weight_reg`와 흘러들어오는 `act`를 곱해 `acc`에 누산한 뒤 아래로 전파한다.

- `act_valid`와 `acc_valid`가 모두 1일 때만 MAC 연산 수행
- 최종 결과는 배열 맨 아래 행 `acc_o[col]`에서 읽음
- weight가 고정되어 있어 동일한 weight로 여러 act를 연속 처리 가능

OS에서는 각 PE의 `acc_o[row][col]`가 output tile 전체였다.
WS에서는 배열 아래쪽의 `acc_o[col]`가 현재 column 방향 누산 결과이다.
따라서 여러 row/column tile을 처리하려면 외부 FSM이 activation stream, weight load, store timing을 함께 제어해야 한다.

### 포트 설명

| 포트               | 방향     | 비트폭             | 설명                    |
| ---------------- | ------ | --------------- | --------------------- |
| `aclk_i`         | input  | 1-bit           | 클락                    |
| `aresetn_i`      | input  | 1-bit           | 액티브 로우 리셋             |
| `act_valid_i`    | input  | 1-bit × ROWS    | 각 행의 activation 유효 신호 |
| `weight_valid_i` | input  | 1-bit           | 모든 PE의 weight 저장 신호   |
| `act_i`          | input  | ACT_W × ROWS    | 각 행의 activation 입력    |
| `weight_i`       | input  | WEIGHT_W × COLS | 각 열에 로드할 weight       |
| `acc_valid_o`    | output | 1-bit × COLS    | 각 열의 출력 유효 신호         |
| `acc_o`          | output | ACC_W × COLS    | 각 열의 최종 누산 결과         |

### systolic_array_ws_non_skew.sv

```systemverilog
module systolic_array_ws_non_skew #(
    parameter int ROWS     = 16,
    parameter int COLS     = 16,
    parameter int ACT_W    = 8,
    parameter int WEIGHT_W = 8,
    parameter int ACC_W    = 32
) (
    input  logic                       aclk_i,
    input  logic                       aresetn_i,
    input  logic                       weight_valid_i,
    input  logic                       act_valid_i   [ROWS],
    input  logic signed [   ACT_W-1:0] act_i         [ROWS],
    input  logic signed [WEIGHT_W-1:0] weight_i      [COLS],
    output logic                       acc_valid_o   [COLS],
    output logic signed [   ACC_W-1:0] acc_o         [COLS]
);

  // PE 간 연결 wire
  logic signed [   ACT_W-1:0] act_wire      [  ROWS][COLS+1];
  logic signed [WEIGHT_W-1:0] weight_wire   [ROWS+1][  COLS];
  logic signed [   ACC_W-1:0] acc_wire      [ROWS+1][  COLS];
  logic                       act_valid_wire[  ROWS][COLS+1];
  logic                       acc_valid_wire[ROWS+1][  COLS];

  // =========================================================
  // 입력 연결
  // =========================================================
  genvar i;
  generate
    for (i = 0; i < ROWS; i++) begin : g_input_act
      assign act_wire[i][0]       = act_i[i];
      assign act_valid_wire[i][0] = act_valid_i[i];
    end

    for (i = 0; i < COLS; i++) begin : g_input_acc
      assign acc_wire[0][i]       = '0;
      assign acc_valid_wire[0][i] = 1'b1;

      assign weight_wire[0][i]    = weight_i[i];
    end
  endgenerate

  // =========================================================
  // 출력 연결
  // =========================================================
  generate
    for (i = 0; i < COLS; i++) begin : g_output
      assign acc_valid_o[i] = acc_valid_wire[ROWS][i];
      assign acc_o[i]       = acc_wire[ROWS][i];
    end
  endgenerate

  // =========================================================
  // PE 배열
  // =========================================================
  genvar row, col;
  generate
    for (row = 0; row < ROWS; row++) begin : g_row
      for (col = 0; col < COLS; col++) begin : g_col
        pe_ws #(
            .ACT_W   (ACT_W),
            .WEIGHT_W(WEIGHT_W),
            .ACC_W   (ACC_W)
        ) u_pe (
            .aclk_i        (aclk_i),
            .aresetn_i     (aresetn_i),
            .act_valid_i   (act_valid_wire[row][col]),
            .weight_valid_i(weight_valid_i),
            .acc_valid_i   (acc_valid_wire[row][col]),
            .act_i         (act_wire[row][col]),
            .weight_i      (weight_wire[row][col]),
            .acc_i         (acc_wire[row][col]),
            .act_valid_o   (act_valid_wire[row][col+1]),
            .acc_valid_o   (acc_valid_wire[row+1][col]),
            .act_o         (act_wire[row][col+1]),
            .weight_o      (weight_wire[row+1][col]),
            .acc_o         (acc_wire[row+1][col])
        );
      end
    end
  endgenerate

endmodule
```

### 왜 Skewing이 필요한가?

OS와 동일하게 WS에서도 skewing이 필요하다.

문제는 두 가지다.

첫째, 모든 행의 `act_i`가 동시에 입력되면 activation이 각 PE에 도착하는 시간이 맞지 않는다.
Systolic Array에서는 같은 `k`에 해당하는 activation과 weight가 같은 PE에서 같은 cycle에 만나야 한다.
하지만 activation은 오른쪽으로 1 cycle씩 이동하고, weight는 아래로 1 cycle씩 이동한다.
따라서 row/column 위치에 따라 도착 시간이 달라진다.

둘째, WS에서는 `acc`가 위에서 아래로 흐른다.
즉 출력도 column 아래쪽으로 순차적으로 흘러나온다.
입력을 skewing해서 넣으면 결과도 skewed timing으로 나오기 때문에, 최종 store 전에 deskewing이 필요하다.

정리하면 WS에서는 다음 두 가지가 필요하다.

| 대상 | 이유 |
|---|---|
| input skewing | 같은 `k`의 activation/weight가 같은 PE에서 만나도록 정렬 |
| output deskewing | 아래로 흘러나오는 `acc_o[col]` 결과 timing 정렬 |

Skewing 구현은 다음 포스트에서 다룬다.
