---
title: "[Systolic Array] 3. WS Systolic Array 설계"
date: 2026-06-06
categories:
  - Hardware
  - RTL
  - Systolic Array
tags:
  - SystemVerilog
  - Systolic_Array
---
## Weight Stationary란?

Weight Stationary(WS)는 **weight를 PE 안에 고정**하는 dataflow이다.

- `weight` (가중치 행렬 B): PE 안에 고정, 이동하지 않음
- `activation` (입력 행렬 A의 행): 왼쪽 → 오른쪽으로 흐름
- `acc` (부분합): 위 → 아래로 흐름

OS와의 핵심 차이는 **acc가 PE 밖으로 흘러나간다**는 점이다.
weight를 한 번 로드하면 여러 activation에 재사용할 수 있어,
동일한 가중치로 반복 연산하는 LLM 추론에 유리하다.

![](/assets/images/Pasted%20image%2020260606155222.png)
## PE 구현

### 동작 흐름

WS에서 PE는 **weight를 내부 레지스터에 고정**한다.

- `weight_load_i`가 1이고 `row_id_i == ROW_ID`일 때만 해당 PE에 weight 로드
- 이후 매 클락마다 `act_i`와 고정된 `weight_reg`를 곱해 `acc_i`에 더한 뒤 `acc_o`로 전파
- `act_i`는 오른쪽으로, `acc_o`는 아래로 전파
- `weight_load_i`와 `row_id_i`도 아래 PE로 전파되어 각 행이 순서대로 weight를 로드

### PE 포트 설계
코드 기반으로 포트 설명 업데이트:

**pe_ws 포트:**

| 포트              | 방향     | 비트폭      | 설명                     |
| --------------- | ------ | -------- | ---------------------- |
| `aclk_i`        | input  | 1-bit    | 클락                     |
| `aresetn_i`     | input  | 1-bit    | 액티브 로우 리셋              |
| `weight_load_i` | input  | 1-bit    | weight 로드 신호           |
| `row_id_i`      | input  | ROW_ID_W | 로드 대상 행 ID             |
| `act_valid_i`   | input  | 1-bit    | activation 유효 신호       |
| `acc_valid_i`   | input  | 1-bit    | acc 유효 신호              |
| `act_i`         | input  | ACT_W    | 왼쪽에서 들어오는 activation   |
| `weight_i`      | input  | WEIGHT_W | 로드할 weight 값           |
| `acc_i`         | input  | ACC_W    | 위에서 들어오는 부분합           |
| `weight_load_o` | output | 1-bit    | 아래 PE로 weight 로드 신호 전달 |
| `row_id_o`      | output | ROW_ID_W | 아래 PE로 행 ID 전달         |
| `act_valid_o`   | output | 1-bit    | 오른쪽 PE로 유효 신호 전달       |
| `acc_valid_o`   | output | 1-bit    | 아래 PE로 유효 신호 전달        |
| `act_o`         | output | ACT_W    | 오른쪽 PE로 activation 전달  |
| `weight_o`      | output | WEIGHT_W | 아래 PE로 weight 전달       |
| `acc_o`         | output | ACC_W    | 아래 PE로 부분합 전달          |
### pe_ws.sv
```SystemVerilog
module pe_ws #(
    parameter int ACT_W    = 8,            // activation 비트폭
    parameter int WEIGHT_W = 8,            // weight 비트폭
    parameter int ACC_W    = 32,           // 누산기 비트폭
    parameter int ROWS     = 16,           // PE 배열 행 수
    parameter int ROW_ID   = 0,            // PE의 행 ID,
    parameter int ROW_ID_W = (ROWS <= 1) ? 1 : $clog2(ROWS)  // 행 ID 비트폭
) (
    input logic                       aclk_i,         // 클락
    input logic                       aresetn_i,      // 액티브 로우 리셋
    input logic                       weight_load_i,  // weight 로드 신호
    input logic        [ROW_ID_W-1:0] row_id_i,       // PE의 행 ID 입력
    input logic                       act_valid_i,    // activation 유효 신호
    input logic                       acc_valid_i,    // acc 유효 신호
    input logic signed [   ACT_W-1:0] act_i,          // 왼쪽 PE에서 전달된 activation
    input logic signed [WEIGHT_W-1:0] weight_i,       // 로드할 weight 값
    input logic signed [   ACC_W-1:0] acc_i,          // 위쪽 PE에서 전달된 부분합

    output logic                       weight_load_o,  // 아래쪽 PE로 weight 신호 전달
    output logic        [ROW_ID_W-1:0] row_id_o,       // 아래쪽 PE로 행 ID 전달
    output logic                       act_valid_o,    // 오른쪽 PE로 유효 신호 전달
    output logic                       acc_valid_o,    // 아래쪽 PE로 유효 신호 전달
    output logic signed [   ACT_W-1:0] act_o,          // 오른쪽 PE로 activation 전달
    output logic signed [WEIGHT_W-1:0] weight_o,       // 아래쪽 PE로 weight 전달
    output logic signed [   ACC_W-1:0] acc_o           // 아래쪽 PE로 부분합 전달
);

  logic signed [WEIGHT_W-1:0] weight_reg;  // PE 내부 고정 weight

  always_ff @(posedge aclk_i) begin
    if (!aresetn_i) begin
      weight_reg    <= 0;
      act_o         <= 0;
      acc_o         <= 0;
      act_valid_o   <= 0;
      acc_valid_o   <= 0;
      weight_load_o <= 0;
      row_id_o      <= 0;
      weight_o      <= 0;
    end else begin
      // weight 로드 단계
      if (weight_load_i && row_id_i == ROW_ID) weight_reg <= weight_i;

      // 신호 전파
      act_o         <= act_i;
      act_valid_o   <= act_valid_i;
      acc_valid_o   <= act_valid_i && acc_valid_i;
      weight_load_o <= weight_load_i;
      row_id_o      <= row_id_i;
      weight_o      <= weight_i;

      // MAC 연산: acc_in + act × weight → 아래로 전파
      if (act_valid_i && acc_valid_i) begin
        acc_o <= acc_i + $signed(act_i) * $signed(weight_reg);
      end else begin
        acc_o <= acc_i;  // valid 아닐 때 그대로 전파
      end
    end
  end

endmodule
```

## Systolic Array 구현

### 동작 흐름

WS 배열에서 입력 신호는 다음과 같이 전달된다.

- `weight_i`: 로드 단계에서 `weight_load_i`와 `row_id`를 통해 각 행 PE에 순차 로드
- `act_i[row]`: 각 행의 왼쪽 끝 PE로 입력, 오른쪽으로 전파
- `acc_o`: 각 열의 위쪽에서 0으로 초기화되어 아래로 전파되며 누산

OS와 달리 연산 전 **weight 로드 단계**가 선행되어야 한다.

#### Weight 로드 단계

연산 전 각 PE에 weight를 로드한다.

- `weight_load_i`와 `row_id_i`를 통해 행별로 순차 로드
- `row_id_i == ROW_ID`인 PE만 해당 클락에 weight를 내부 레지스터에 저장
- 로드 신호는 아래 PE로 전파되어 모든 행이 순차적으로 로드

#### 연산 단계

매 클락마다 각 PE는 고정된 `weight_reg`와 흘러들어오는 `act`를 곱해 `acc`에 누산한 뒤 아래로 전파한다.

- `act_valid`와 `acc_valid`가 모두 1일 때만 MAC 연산 수행
- 최종 결과는 배열 맨 아래 행 `acc_o[col]`에서 읽음
- weight가 고정되어 있어 동일한 weight로 여러 act를 연속 처리 가능

### 포트 설명

| 포트              | 방향     | 비트폭             | 설명                    |
| --------------- | ------ | --------------- | --------------------- |
| `aclk_i`        | input  | 1-bit           | 클락                    |
| `aresetn_i`     | input  | 1-bit           | 액티브 로우 리셋             |
| `weight_load_i` | input  | 1-bit × COLS    | 각 열의 weight 로드 신호     |
| `row_id_i`      | input  | ROW_ID_W        | 각 열의 로드 대상 행 ID       |
| `act_valid_i`   | input  | 1-bit × ROWS    | 각 행의 activation 유효 신호 |
| `act_i`         | input  | ACT_W × ROWS    | 각 행의 activation 입력    |
| `weight_i`      | input  | WEIGHT_W × COLS | 각 열에 로드할 weight       |
| `acc_valid_o`   | output | 1-bit × COLS    | 각 열의 출력 유효 신호         |
| `acc_o`         | output | ACC_W × COLS    | 각 열의 최종 누산 결과         |

### systolic_array_ws_non_skew.sv

```systemverilog
module systolic_array_ws_non_skew #(
    parameter int ROWS     = 16,
    parameter int COLS     = 16,
    parameter int ACT_W    = 8,
    parameter int WEIGHT_W = 8,
    parameter int ACC_W    = 32,
    parameter int ROW_ID_W = (ROWS <= 1) ? 1 : $clog2(ROWS)
) (
    input  logic                       aclk_i,
    input  logic                       aresetn_i,
    input  logic                       weight_load_i[COLS],  // weight 로드 신호
    input  logic        [ROW_ID_W-1:0] row_id_i,             // 로드 대상 행 ID
    input  logic                       act_valid_i  [ROWS],  // 각 행의 activation 신호
    input  logic signed [   ACT_W-1:0] act_i        [ROWS],  // 각 행의 activation
    input  logic signed [WEIGHT_W-1:0] weight_i     [COLS],  // 로드할 weight
    output logic                       acc_valid_o  [COLS],  // 각 열의 최종 출력 valid
    output logic signed [   ACC_W-1:0] acc_o        [COLS]   // 각 열의 최종 출력
);

  // PE 간 연결 wire
  logic signed [   ACT_W-1:0] act_wire        [  ROWS][COLS+1];
  logic signed [   ACC_W-1:0] acc_wire        [ROWS+1][  COLS];
  logic signed [WEIGHT_W-1:0] weight_wire     [ROWS+1][  COLS];
  logic                       act_valid_wire  [  ROWS][COLS+1];
  logic                       acc_valid_wire  [ROWS+1][  COLS];
  logic                       weight_load_wire[ROWS+1][  COLS];
  logic        [ROW_ID_W-1:0] row_id_wire     [ROWS+1][  COLS];

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
      assign acc_wire[0][i]         = '0;  // 최상단 acc 초기값 0
      assign acc_valid_wire[0][i]   = 1'b1;
      assign weight_wire[0][i]      = weight_i[i];
      assign weight_load_wire[0][i] = weight_load_i[i];
      assign row_id_wire[0][i]      = row_id_i;
    end
  endgenerate

  // 각 열의 최종 출력
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
            .ACC_W   (ACC_W),
            .ROWS    (ROWS),
            .ROW_ID  (row),
            .ROW_ID_W(ROW_ID_W)
        ) u_pe (
            .aclk_i       (aclk_i),
            .aresetn_i    (aresetn_i),
            // inputs
            .weight_load_i(weight_load_wire[row][col]),
            .row_id_i     (row_id_wire[row][col]),
            .act_valid_i  (act_valid_wire[row][col]),
            .acc_valid_i  (acc_valid_wire[row][col]),
            .act_i        (act_wire[row][col]),
            .weight_i     (weight_wire[row][col]),
            .acc_i        (acc_wire[row][col]),
            // outputs
            .weight_load_o(weight_load_wire[row+1][col]),
            .row_id_o     (row_id_wire[row+1][col]),
            .act_valid_o  (act_valid_wire[row][col+1]),
            .acc_valid_o  (acc_valid_wire[row+1][col]),
            .act_o        (act_wire[row][col+1]),
            .weight_o     (weight_wire[row+1][col]),
            .acc_o        (acc_wire[row+1][col])
        );
      end
    end
  endgenerate

endmodule
```

### 왜 Skewing이 필요한가?

OS와 동일하게 WS에서도 `act_i`가 모든 행에 동시에 입력되면 타이밍이 어긋난다. 
또한 출력되는 acc도 skewing 형태로 나오기 때문에 이를 Deskewing해야 한다.
Skewing 구현은 다음 포스트에서 다룬다.
