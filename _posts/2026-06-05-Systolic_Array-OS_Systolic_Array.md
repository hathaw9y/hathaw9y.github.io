---
title: "[Systolic Array] 2. OS Systolic Array 설계"
date: 2026-06-05
categories:
  - Hardware
  - RTL
  - Systolic Array
tags:
  - SystemVerilog
  - Systolic_Array
---
## Output Stationary란? 

Output Stationary(OS)는 **출력 행렬 C의 부분합을 PE 안에 고정**하는 dataflow이다. 

- `activation` (입력 행렬 A의 행): 왼쪽 → 오른쪽으로 흐름 
- `weight` (가중치 행렬 B의 열): 위 → 아래로 흐름 
- `acc` (부분합): PE 안에서 누산, 이동하지 않음 

![](/assets/images/Pasted%20image%2020260606134247.png)

## PE 구현

### 동작 흐름

매 클락마다 `act_i`와 `weight_i`를 각각 오른쪽, 아래 PE로 1클락 지연 전파한다.

양쪽 valid가 모두 1일 때만 MAC 연산을 수행해 `acc_o`에 누산한다.

`acc_clear_i`가 1이면 누산 전에 `acc_o`를 0으로 초기화하며, 이 신호도 오른쪽으로 전파된다.

### PE 포트 설계

| 포트               | 방향     | 비트폭      | 설명                   |
| ---------------- | ------ | -------- | -------------------- |
| `aclk_i`         | input  | 1-bit    | 클락                   |
| `aresetn_i`      | input  | 1-bit    | 액티브 로우 리셋            |
| `act_valid_i`    | input  | 1-bit    | 입력 activation 유효 신호  |
| `weight_valid_i` | input  | 1-bit    | 입력 weight 유효 신호      |
| `acc_clear_i`    | input  | 1-bit    | acc 초기화 신호           |
| `act_i`          | input  | ACT_W    | 왼쪽에서 들어오는 activation |
| `weight_i`       | input  | WEIGHT_W | 위에서 들어오는 weight      |
| `act_valid_o`    | output | 1-bit    | activation 유효 신호 전달  |
| `weight_valid_o` | output | 1-bit    | weight 유효 신호 전달      |
| `acc_clear_o`    | output | 1-bit    | acc 초기화 신호 전달        |
| `act_o`          | output | ACT_W    | 오른쪽 PE로 전달           |
| `weight_o`       | output | WEIGHT_W | 아래 PE로 전달            |
| `acc_o`          | output | ACC_W    | 누산 결과 (부분합)          |

### pe_os.sv

```SystemVerilog
module pe_os #(
    parameter int ACT_W    = 8,   // activation 비트폭
    parameter int WEIGHT_W = 8,   // weight 비트폭
    parameter int ACC_W    = 32   // 누산기 비트폭 (오버플로우 방지)
) (
    input  logic                       aclk_i,          // 클락
    input  logic                       aresetn_i,       // 액티브 로우 리셋
    input  logic                       act_valid_i,     // activation 유효 신호
    input  logic                       weight_valid_i,  // weight 유효 신호
    input  logic                       acc_clear_i,     // acc 초기화 신호
    input  logic signed [   ACT_W-1:0] act_i,           // 왼쪽 PE에서 전달된 activation
    input  logic signed [WEIGHT_W-1:0] weight_i,        // 위쪽 PE에서 전달된 weight
    output logic                       act_valid_o,     // 오른쪽 PE로 유효 신호 전달
    output logic                       weight_valid_o,  // 아래쪽 PE로 유효 신호 전달
    output logic                       acc_clear_o,     // 오른쪽 PE로 초기화 신호 전달
    output logic signed [   ACT_W-1:0] act_o,           // 오른쪽 PE로 activation 전달
    output logic signed [WEIGHT_W-1:0] weight_o,        // 아래쪽 PE로 weight 전달
    output logic signed [   ACC_W-1:0] acc_o            // 누산 결과 출력
);

  always_ff @(posedge aclk_i) begin
    if (!aresetn_i) begin
      act_valid_o    <= 0;
      weight_valid_o <= 0;
      act_o          <= 0;
      weight_o       <= 0;
      acc_o          <= 0;
      acc_clear_o    <= 0;
    end else begin
      // 신호 및 데이터를 인접 PE로 1클락 지연 전파
      act_valid_o    <= act_valid_i;
      weight_valid_o <= weight_valid_i;
      acc_clear_o    <= acc_clear_i;
      act_o          <= act_i;
      weight_o       <= weight_i;

      // acc 누산: clear 우선, 이후 양쪽 valid일 때만 누산
      if (acc_clear_i) begin
        acc_o <= 0;  // 타일 경계에서 부분합 초기화
      end else if (act_valid_i && weight_valid_i) begin
        acc_o <= acc_o + $signed(act_i) * $signed(weight_i);
      end
    end
  end

endmodule
```

## Systolic Array 구현

### 동작 흐름

입력 신호는 다음과 같이 PE 배열로 전달된다.

- `act_i[row]`: 각 행의 왼쪽 끝 PE로 입력, 오른쪽으로 전파
- `weight_i[col]`: 각 열의 위쪽 끝 PE로 입력, 아래로 전파
- 매 클락마다 각 PE는 `act`와 `weight`를 곱해 `acc_o`에 누산

모든 PE가 동시에 연산을 수행하기 때문에, 16×16 배열에서 매 클락마다 256개의 MAC 연산이 병렬로 진행된다.

### 포트 설명

| 포트 | 방향 | 비트폭 | 설명 |
|---|---|---|---|
| `aclk_i` | input | 1-bit | 클락 |
| `aresetn_i` | input | 1-bit | 액티브 로우 리셋 |
| `act_valid_i` | input | 1-bit | activation 유효 신호 (전체 배열 공통) |
| `weight_valid_i` | input | 1-bit | weight 유효 신호 (전체 배열 공통) |
| `acc_clear_i` | input | 1-bit | acc 초기화 신호 (전체 배열 공통) |
| `act_i` | input | ACT_W × ROWS | 각 행의 activation 입력 |
| `weight_i` | input | WEIGHT_W × COLS | 각 열의 weight 입력 |
| `acc_o` | output | ACC_W × ROWS × COLS | 출력 행렬 C의 부분합 |

### systolic_array_os_non_skew.sv
```SystemVerilog
module systolic_array_os_non_skew #(
    parameter int ROWS     = 16,
    parameter int COLS     = 16,
    parameter int ACT_W    = 8,
    parameter int WEIGHT_W = 8,
    parameter int ACC_W    = 32
) (
    input  logic                       aclk_i,
    input  logic                       aresetn_i,
    input  logic signed [   ACT_W-1:0] act_i         [ROWS],
    input  logic signed [WEIGHT_W-1:0] weight_i      [COLS],
    input  logic                       act_valid_i,
    input  logic                       weight_valid_i,
    input  logic                       acc_clear_i,
    output logic signed [   ACC_W-1:0] acc_o         [ROWS][COLS]
);

  // PE 간 연결 wire
  logic signed [   ACT_W-1:0] act_wire         [  ROWS][COLS+1];
  logic signed [WEIGHT_W-1:0] weight_wire      [ROWS+1][  COLS];
  logic                       act_valid_wire   [  ROWS][COLS+1];
  logic                       weight_valid_wire[ROWS+1][  COLS];
  logic                       acc_clear_wire   [  ROWS][COLS+1];

  // =========================================================
  // 입력 연결
  // =========================================================
  genvar i;
  generate
    for (i = 0; i < ROWS; i++) begin : g_input_act
      assign act_wire[i][0]       = act_i[i];
      assign act_valid_wire[i][0] = act_valid_i;
      assign acc_clear_wire[i][0] = acc_clear_i;
    end
    for (i = 0; i < COLS; i++) begin : g_input_weight
      assign weight_wire[0][i]       = weight_i[i];
      assign weight_valid_wire[0][i] = weight_valid_i;
    end
  endgenerate

  // =========================================================
  // PE 배열
  // =========================================================
  genvar row, col;
  generate
    for (row = 0; row < ROWS; row++) begin : g_row
      for (col = 0; col < COLS; col++) begin : g_col
        pe_os #(
            .ACT_W   (ACT_W),
            .WEIGHT_W(WEIGHT_W),
            .ACC_W   (ACC_W)
        ) u_pe (
            .aclk_i        (aclk_i),
            .aresetn_i     (aresetn_i),
            // inputs
            .act_valid_i   (act_valid_wire[row][col]),
            .weight_valid_i(weight_valid_wire[row][col]),
            .acc_clear_i   (acc_clear_wire[row][col]),
            .act_i         (act_wire[row][col]),
            .weight_i      (weight_wire[row][col]),
            // outputs
            .act_valid_o   (act_valid_wire[row][col+1]),
            .weight_valid_o(weight_valid_wire[row+1][col]),
            .acc_clear_o   (acc_clear_wire[row][col+1]),
            .act_o         (act_wire[row][col+1]),
            .weight_o      (weight_wire[row+1][col]),
            .acc_o         (acc_o[row][col])
        );
      end
    end
  endgenerate

endmodule
```


## 왜 Skewing이 필요한가?

위 코드에는 치명적인 문제가 있다. 모든 행에 `act_i`가 **동시에** 입력된다.

예를 들어 다음 행렬 곱셈을 생각해자.

$$C = A \times B$$

$$A = \begin{bmatrix} a_{00} & a_{01} \\ a_{10} & a_{11} \end{bmatrix}, \quad B = \begin{bmatrix} b_{00} & b_{01} \\ b_{10} & b_{11} \end{bmatrix}$$

`C[0][0]`을 구하려면 PE₀₀에서 $a_{00} \times b_{00}$, PE₀₁에서 $a_{01} \times b_{10}$이 누산되어야 한다.

그런데 skewing 없이 데이터를 동시에 입력하면:

- 클락 0: PE₀₀에 $a_{00}$, PE₀₁에 $a_{00}$이 동시 도착
- 클락 1: PE₀₀에 $a_{01}$이 도착하지만, PE₀₁에는 이미 $a_{00}$이 지나간 뒤

즉, PE₀₁은 $a_{00} \times b_{10}$을 계산해야 하는데 $a_{00}$이 PE₀₁에 도달하는 시점에 $b_{10}$이 아직 내려오지 않아 **타이밍이 어긋난다.**

올바른 연산을 위해 각 행의 입력을 **1클락씩 지연**시켜야 한다.

| 행 | 지연 클락 |
|---|---|
| 행 0 | 0 클락 |
| 행 1 | 1 클락 |
| 행 2 | 2 클락 |
| 행 N-1 | N-1 클락 |
Skewing 구현은 다음 포스트에서 다룬다.
