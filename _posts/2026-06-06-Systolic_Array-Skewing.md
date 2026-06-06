---
title: "[Systolic Array] 4. Skewing 구현"
date: 2026-06-06 11:00:00 +0900
categories:
  - Hardware
  - RTL
  - Systolic Array
tags:
  - SystemVerilog
  - Systolic_Array
---
## Skewing이란?

앞서 OS/WS 구현에서 모든 행의 `act_i`가 동시에 입력되면 타이밍이 어긋나는 문제를 확인했다.

Skewing은 각 행의 입력을 **행 번호만큼 지연**시켜 올바른 타이밍에 데이터가 만나도록 하는 기법이다.

| 행 | 지연 클락 |
|---|---|
| 행 0 | 0 클락 |
| 행 1 | 1 클락 |
| 행 2 | 2 클락 |
| 행 N-1 | N-1 클락 |

## pipeline_reg 구현

`pipeline_reg`는 입력 데이터를 `DEPTH` 클락만큼 지연시키는 shift register다.
행 번호를 `DEPTH`로 설정하면 각 행의 입력을 순차적으로 지연시킬 수 있다.

### 포트 설명

| 포트 | 방향 | 비트폭 | 설명 |
|---|---|---|---|
| `aclk_i` | input | 1-bit | 클락 |
| `aresetn_i` | input | 1-bit | 액티브 로우 리셋 |
| `data_i` | input | DATA_W | 입력 데이터 |
| `data_o` | output | DATA_W | DEPTH 클락 지연된 출력 |

### 코드 구현

```systemverilog
module pipeline_reg #(
    parameter int DATA_W = 8,  // 데이터 비트폭
    parameter int DEPTH  = 0   // 지연 클락 수 (행 번호와 동일)
) (
    input  logic              aclk_i,
    input  logic              aresetn_i,
    input  logic [DATA_W-1:0] data_i,
    output logic [DATA_W-1:0] data_o
);

  if (DEPTH == 0) begin : g_no_delay
    assign data_o = data_i;
  end else begin : g_delay
    logic [DATA_W-1:0] shift_reg[DEPTH];

    always_ff @(posedge aclk_i) begin
      if (!aresetn_i) begin
        for (int i = 0; i < DEPTH; i++) shift_reg[i] <= '0;
      end else begin
        shift_reg[0] <= data_i;
        for (int i = 1; i < DEPTH; i++) shift_reg[i] <= shift_reg[i-1];
      end
    end

    assign data_o = shift_reg[DEPTH-1];
  end

endmodule
```


## OS+SKEW
### Skewing 동작

입력 데이터를 행/열 번호만큼 지연시켜 PE에 전달한다.

- `act_i[row]`: `row` 클락만큼 지연 후 해당 행 왼쪽 끝 PE로 입력
- `weight_i[col]`: `col` 클락만큼 지연 후 해당 열 위쪽 끝 PE로 입력
- `act_valid_i`, `weight_valid_i`, `acc_clear_i`도 동일하게 지연

### systolic_array_os.sv
```SystemVerilog
module systolic_array_os #(
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

  // Skewed 신호
  logic signed [   ACT_W-1:0] act_skewed         [  ROWS];
  logic                       act_valid_skewed   [  ROWS];
  logic                       acc_clear_skewed   [  ROWS];
  logic signed [WEIGHT_W-1:0] weight_skewed      [  COLS];
  logic                       weight_valid_skewed[  COLS];
  // PE 간 연결 wire
  logic signed [   ACT_W-1:0] act_wire           [  ROWS] [COLS+1];
  logic signed [WEIGHT_W-1:0] weight_wire        [ROWS+1] [  COLS];
  logic                       act_valid_wire     [  ROWS] [COLS+1];
  logic                       weight_valid_wire  [ROWS+1] [  COLS];
  logic                       acc_clear_wire     [  ROWS] [COLS+1];

  // =========================================================
  // Skewing: act는 행 번호, weight는 열 번호만큼 지연
  // =========================================================
  genvar i;
  generate
    // act skewing (행 방향)
    for (i = 0; i < ROWS; i++) begin : g_skew_act
      pipeline_reg #(
          .DATA_W(ACT_W),
          .DEPTH (i)
      ) u_skew_act (
          .aclk_i   (aclk_i),
          .aresetn_i(aresetn_i),
          .data_i   (act_i[i]),
          .data_o   (act_skewed[i])
      );

      pipeline_reg #(
          .DATA_W(1),
          .DEPTH (i)
      ) u_skew_act_valid (
          .aclk_i   (aclk_i),
          .aresetn_i(aresetn_i),
          .data_i   (act_valid_i[i]),
          .data_o   (act_valid_skewed[i])
      );

      pipeline_reg #(
          .DATA_W(1),
          .DEPTH (i)
      ) u_skew_clear (
          .aclk_i   (aclk_i),
          .aresetn_i(aresetn_i),
          .data_i   (acc_clear_i),
          .data_o   (acc_clear_skewed[i])
      );
    end

    // weight skewing (열 방향)
    for (i = 0; i < COLS; i++) begin : g_skew_weight
      pipeline_reg #(
          .DATA_W(WEIGHT_W),
          .DEPTH (i)
      ) u_skew_weight (
          .aclk_i   (aclk_i),
          .aresetn_i(aresetn_i),
          .data_i   (weight_i[i]),
          .data_o   (weight_skewed[i])
      );

      pipeline_reg #(
          .DATA_W(1),
          .DEPTH (i)
      ) u_skew_weight_valid (
          .aclk_i   (aclk_i),
          .aresetn_i(aresetn_i),
          .data_i   (weight_valid_i[i]),
          .data_o   (weight_valid_skewed[i])
      );
    end
  endgenerate

  // =========================================================
  // 입력 연결
  // =========================================================
  generate
    for (i = 0; i < ROWS; i++) begin : g_input_act
      assign act_wire[i][0]       = act_skewed[i];
      assign act_valid_wire[i][0] = act_valid_skewed[i];
      assign acc_clear_wire[i][0] = acc_clear_skewed[i];
    end
    for (i = 0; i < COLS; i++) begin : g_input_weight
      assign weight_wire[0][i]       = weight_skewed[i];
      assign weight_valid_wire[0][i] = weight_valid_skewed[i];
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
            .act_valid_i   (act_valid_wire[row][col]),
            .weight_valid_i(weight_valid_wire[row][col]),
            .acc_clear_i   (acc_clear_wire[row][col]),
            .act_i         (act_wire[row][col]),
            .weight_i      (weight_wire[row][col]),
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

## WS+Skewing
### Skewing 동작

weight 로드 완료 후 act를 행 번호만큼 지연시켜 입력한다.

- `act_i[row]`: `row` 클락만큼 지연 후 해당 행 왼쪽 끝 PE로 입력
- OS와 달리 weight는 이미 PE 내부에 고정되어 있으므로 skew 불필요

### Deskewing 동작

act를 행 번호만큼 skew했기 때문에 각 열의 결과값이 서로 다른 타이밍에 완성된다.

- 열 0: 가장 먼저 완성
- 열 1: 1 클락 늦게 완성
- 열 N-1: N-1 클락 늦게 완성

이를 보정하기 위해 출력단에서 **역방향으로 지연**을 추가한다.

| 열 | deskew 지연 클락 |
|---|---|
| 열 0 | COLS-1 클락 |
| 열 1 | COLS-2 클락 |
| 열 N-1 | 0 클락 |

이렇게 하면 모든 열의 결과가 동일한 클락에 출력된다.

### systolic_array_ws.sv
```SystemVerilog
module systolic_array_ws #(
    parameter int ROWS     = 16,
    parameter int COLS     = 16,
    parameter int ACT_W    = 8,
    parameter int WEIGHT_W = 8,
    parameter int ACC_W    = 32,
    parameter int ROW_ID_W = (ROWS <= 1) ? 1 : $clog2(ROWS)
) (
    input  logic                       aclk_i,
    input  logic                       aresetn_i,
    input  logic                       weight_load_i[COLS],
    input  logic        [ROW_ID_W-1:0] row_id_i,
    input  logic                       act_valid_i  [ROWS],
    input  logic signed [   ACT_W-1:0] act_i        [ROWS],
    input  logic signed [WEIGHT_W-1:0] weight_i     [COLS],
    output logic                       acc_valid_o  [COLS],
    output logic signed [   ACC_W-1:0] acc_o        [COLS]
);

  // Skewed 신호
  logic signed [   ACT_W-1:0] act_skewed        [  ROWS];
  logic                       act_valid_skewed  [  ROWS];
  // PE 간 연결 wire
  logic signed [   ACT_W-1:0] act_wire          [  ROWS] [COLS+1];
  logic signed [   ACC_W-1:0] acc_wire          [ROWS+1] [  COLS];
  logic signed [WEIGHT_W-1:0] weight_wire       [ROWS+1] [  COLS];
  logic                       act_valid_wire    [  ROWS] [COLS+1];
  logic                       acc_valid_wire    [ROWS+1] [  COLS];
  logic                       weight_load_wire  [ROWS+1] [  COLS];
  logic        [ROW_ID_W-1:0] row_id_wire       [ROWS+1] [  COLS];
  // Deskewed 신호
  logic signed [   ACC_W-1:0] acc_deskewed      [  COLS];
  logic                       acc_valid_deskewed[  COLS];

  // =========================================================
  // Skewing: act는 행 번호만큼 지연
  // =========================================================
  genvar i;
  generate
    for (i = 0; i < ROWS; i++) begin : g_skew_act
      pipeline_reg #(
          .DATA_W(ACT_W),
          .DEPTH (i)
      ) u_skew_act (
          .aclk_i   (aclk_i),
          .aresetn_i(aresetn_i),
          .data_i   (act_i[i]),
          .data_o   (act_skewed[i])
      );

      pipeline_reg #(
          .DATA_W(1),
          .DEPTH (i)
      ) u_skew_act_valid (
          .aclk_i   (aclk_i),
          .aresetn_i(aresetn_i),
          .data_i   (act_valid_i[i]),
          .data_o   (act_valid_skewed[i])
      );
    end
  endgenerate

  // =========================================================
  // 입력 연결
  // =========================================================
  generate
    for (i = 0; i < ROWS; i++) begin : g_input_act
      assign act_wire[i][0]       = act_skewed[i];
      assign act_valid_wire[i][0] = act_valid_skewed[i];
    end
    for (i = 0; i < COLS; i++) begin : g_input_acc
      assign acc_wire[0][i]         = '0;
      assign acc_valid_wire[0][i]   = 1'b1;
      assign weight_wire[0][i]      = weight_i[i];
      assign weight_load_wire[0][i] = weight_load_i[i];
      assign row_id_wire[0][i]      = row_id_i;
    end
  endgenerate

  // =========================================================
  // Deskewing: acc는 (전체 열 - 열 번호)만큼 지연
  // =========================================================
  generate
    for (i = 0; i < COLS; i++) begin : g_output
      pipeline_reg #(
          .DATA_W(ACC_W),
          .DEPTH (COLS - 1 - i)
      ) u_deskew_acc (
          .aclk_i   (aclk_i),
          .aresetn_i(aresetn_i),
          .data_i   (acc_wire[ROWS][i]),
          .data_o   (acc_deskewed[i])
      );

      pipeline_reg #(
          .DATA_W(1),
          .DEPTH (COLS - 1 - i)
      ) u_deskew_acc_valid (
          .aclk_i   (aclk_i),
          .aresetn_i(aresetn_i),
          .data_i   (acc_valid_wire[ROWS][i]),
          .data_o   (acc_valid_deskewed[i])
      );

      assign acc_valid_o[i] = acc_valid_deskewed[i];
      assign acc_o[i]       = acc_deskewed[i];
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
            .weight_load_i(weight_load_wire[row][col]),
            .row_id_i     (row_id_wire[row][col]),
            .act_valid_i  (act_valid_wire[row][col]),
            .acc_valid_i  (acc_valid_wire[row][col]),
            .act_i        (act_wire[row][col]),
            .weight_i     (weight_wire[row][col]),
            .acc_i        (acc_wire[row][col]),
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
