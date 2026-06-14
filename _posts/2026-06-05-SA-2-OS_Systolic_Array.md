---
title: OS Systolic Array 설계
date: 2026-06-05
series: Systolic Array
series_order: 2
categories: Hardware
subcategory: RTL
tags:
  - SystemVerilog
  - Systolic_Array
---
## Output Stationary란? 

Output Stationary(OS)는 **출력 행렬 C의 부분합을 PE 안에 고정**하는 dataflow이다.

행렬 곱셈은 다음처럼 계산된다.

$$C_{i,j} = \sum_k A_{i,k} \times B_{k,j}$$

OS에서는 PE 하나가 출력 행렬 C의 한 원소를 담당한다.
예를 들어 PE `(row, col)`은 `C[row][col]`의 부분합을 내부에 계속 누산한다.

따라서 데이터 흐름은 다음처럼 정해진다.

- `activation` (입력 행렬 A의 행): 왼쪽 → 오른쪽으로 흐름 
- `weight` (가중치 행렬 B의 열): 위 → 아래로 흐름 
- `acc` (부분합): PE 안에서 누산, 이동하지 않음 

![](/assets/images/Pasted%20image%2020260606134247.png)

핵심은 `acc`가 PE 밖으로 이동하지 않는다는 점이다.
매 cycle마다 PE는 왼쪽에서 들어온 activation과 위에서 들어온 weight를 곱하고, 그 결과를 자기 내부의 `acc_o`에 더한다.

```text
PE(row, col)
  acc[row][col] += act_from_left * weight_from_top
```

이 구조에서는 결과를 저장하기 전까지 각 PE가 자기 출력값을 들고 있는다.
그래서 tile 계산을 새로 시작할 때는 PE 내부 accumulator를 반드시 초기화해야 한다.
이때 사용하는 신호가 `acc_clear_i`이다.

## PE

### PE가 하는 일
![](assets/images/Pasted%20image%2020260606134247.png)
PE 하나는 매우 단순하다.

1. 왼쪽에서 `act_i`를 받는다.
2. 위쪽에서 `weight_i`를 받는다.
3. 두 값이 모두 유효하면 곱해서 `acc_o`에 더한다.
4. `act_i`는 오른쪽 PE로 전달한다.
5. `weight_i`는 아래쪽 PE로 전달한다.

valid 신호도 데이터와 같은 방향으로 이동한다.

- `act_valid_i`: activation이 유효한지 표시하고 오른쪽으로 전달
- `weight_valid_i`: weight가 유효한지 표시하고 아래쪽으로 전달
- `acc_clear_i`: accumulator 초기화 신호이며 activation 방향과 같이 오른쪽으로 전달

`acc_clear_i`를 오른쪽으로 전달하는 이유는 각 행의 PE들이 같은 행 안에서 activation 흐름을 따라 순서대로 clear되어야 하기 때문이다.
나중에 skewing을 적용하면 row마다 입력 시점이 달라지므로, clear 신호도 데이터 흐름과 맞춰 전파되어야 한다.

### 누산 조건

PE는 매 cycle마다 무조건 MAC을 수행하지 않는다.
activation과 weight가 모두 유효할 때만 누산해야 한다.

```systemverilog
if (act_valid_i && weight_valid_i) begin
  acc_o <= acc_o + $signed(act_i) * $signed(weight_i);
end
```

그리고 tile이 바뀌면 이전 tile의 부분합이 남아 있으면 안 된다.
그래서 clear가 MAC보다 우선순위를 가진다.

```systemverilog
if (acc_clear_i) begin
  acc_o <= 0;
end else if (act_valid_i && weight_valid_i) begin
  acc_o <= acc_o + $signed(act_i) * $signed(weight_i);
end
```

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

### PE를 2D로 연결하기

PE 하나는 한 개의 `C[row][col]`만 계산한다.
따라서 `ROWS x COLS`개의 PE를 2D grid로 배치하면 한 번에 `ROWS x COLS` 크기의 output tile을 계산할 수 있다.

![SA](/assets/images/Systolic_Array_4x4.png)

입력 신호는 다음과 같이 PE 배열로 전달된다.

- `act_i[row]`: 각 행의 왼쪽 끝 PE로 입력, 오른쪽으로 전파
- `weight_i[col]`: 각 열의 위쪽 끝 PE로 입력, 아래로 전파
- `acc_o[row][col]`: PE `(row, col)`이 담당하는 C tile의 부분합

모든 PE가 동시에 연산을 수행하기 때문에, 16×16 배열에서 매 클락마다 256개의 MAC 연산이 병렬로 진행된다.

```text
act_i[0] -> PE(0,0) -> PE(0,1) -> ... -> PE(0,COLS-1)
act_i[1] -> PE(1,0) -> PE(1,1) -> ... -> PE(1,COLS-1)
...

weight_i[0] ↓ PE(0,0) ↓ PE(1,0) ↓ ... ↓ PE(ROWS-1,0)
weight_i[1] ↓ PE(0,1) ↓ PE(1,1) ↓ ... ↓ PE(ROWS-1,1)
```

즉 activation은 row 방향으로 퍼지고, weight는 column 방향으로 퍼진다.
두 값이 어떤 PE에서 같은 cycle에 만나느냐가 올바른 GEMM 계산의 핵심이다.

### 포트 설명

| 포트               | 방향     | 비트폭                 | 설명                    |
| ---------------- | ------ | ------------------- | --------------------- |
| `aclk_i`         | input  | 1-bit               | 클락                    |
| `aresetn_i`      | input  | 1-bit               | 액티브 로우 리셋             |
| `act_valid_i`    | input  | 1-bit × ROWS        | activation 유효 신호      |
| `weight_valid_i` | input  | 1-bit × COLS        | weight 유효 신호          |
| `acc_clear_i`    | input  | 1-bit               | acc 초기화 신호 (전체 배열 공통) |
| `act_i`          | input  | ACT_W × ROWS        | 각 행의 activation 입력    |
| `weight_i`       | input  | WEIGHT_W × COLS     | 각 열의 weight 입력        |
| `acc_o`          | output | ACC_W × ROWS × COLS | 출력 행렬 C의 부분합          |

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
    input  logic                       act_valid_i   [ROWS],
    input  logic                       weight_valid_i[COLS],
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

위 코드는 PE 연결 구조를 보여주기 위한 non-skew 버전이다.
하지만 이 상태로는 올바른 행렬 곱셈이 되지 않는다.

문제는 모든 행의 `act_i`와 모든 열의 `weight_i`가 **동시에** 입력된다는 점이다.
Systolic Array에서는 같은 `k`에 해당하는 `A[row][k]`와 `B[k][col]`이 같은 PE에서 같은 cycle에 만나야 한다.
그런데 데이터가 PE 사이를 1 cycle씩 이동하기 때문에, 행과 열 위치가 달라질수록 도착 시간이 달라진다.

예를 들어 다음 행렬 곱셈을 생각해보자.

$$C = A \times B$$

$$A = \begin{bmatrix} a_{00} & a_{01} \\ a_{10} & a_{11} \end{bmatrix}, \quad B = \begin{bmatrix} b_{00} & b_{01} \\ b_{10} & b_{11} \end{bmatrix}$$

각 PE는 다음 값을 담당한다.

| PE | 담당 출력 |
|---|---|
| PE(0,0) | `C[0][0]` |
| PE(0,1) | `C[0][1]` |
| PE(1,0) | `C[1][0]` |
| PE(1,1) | `C[1][1]` |

예를 들어 `C[1][1]`은 다음처럼 계산되어야 한다.

$$C_{1,1} = a_{10}b_{01} + a_{11}b_{11}$$

즉 PE(1,1)에서는 같은 cycle에 아래 조합이 만나야 한다.

| k | activation | weight |
|---|---|---|
| 0 | `a10` | `b01` |
| 1 | `a11` | `b11` |

하지만 PE(1,1)은 왼쪽 끝과 위쪽 끝에서 각각 한 칸 떨어져 있다.
그래서 activation은 PE(1,0)을 한 번 지나와야 하고, weight는 PE(0,1)을 한 번 지나와야 한다.
이처럼 PE 위치에 따라 데이터 도착 시간이 달라진다.

skewing 없이 데이터를 동시에 입력하면 다음 문제가 생긴다.

- 같은 row의 activation들이 너무 빨리 오른쪽으로 이동한다.
- 같은 column의 weight들도 너무 빨리 아래로 이동한다.
- 특정 PE에서 같은 `k`에 해당하는 activation과 weight가 같은 cycle에 만나지 못한다.

결과적으로 `a[row][k] * b[k][col]`이 아니라, 서로 다른 `k`의 activation과 weight가 곱해질 수 있다.

이를 해결하려면 입력을 대각선 방향으로 밀어 넣어야 한다.
즉 row가 증가할수록 activation을 더 늦게 넣고, column이 증가할수록 weight를 더 늦게 넣는다.

| 입력 | 지연 |
|---|---|
| `act_i[row]` | row만큼 지연 |
| `weight_i[col]` | col만큼 지연 |

이렇게 skewing을 적용하면 같은 `k`의 activation과 weight가 각 PE에서 같은 cycle에 만나게 된다.

Skewing 구현은 다음 포스트에서 다룬다.
