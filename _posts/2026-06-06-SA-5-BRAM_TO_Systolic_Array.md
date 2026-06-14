---
title: BRAM 읽고 쓰기
date: 2026-06-06 12:00:00 +0900
series: Systolic Array
series_order: 5
categories: Hardware
subcategory: RTL
tags:
  - SystemVerilog
  - Systolic_Array
---
## BRAM이란?

BRAM(Block RAM)은 FPGA 내부에 하드웨어로 내장된 메모리다. DRAM과 달리 FPGA 패브릭 안에 위치해 **단일 클락에 읽기/쓰기**가 가능하고, 외부 메모리 접근 없이 낮은 레이턴시로 데이터를 공급할 수 있다.

ZCU104 기준 BRAM은 36Kb 블록 단위로 구성되며, Vivado에서 `Block Memory Generator` IP로 쉽게 인스턴스화할 수 있다.

Systolic Array에 데이터를 공급/저장을 하기 위해 BRAM을 사용한다. 

이 시리즈에서는 **Simple Dual Port** 모드를 사용한다. 읽기 포트와 쓰기 포트가 분리되어 있어 동시에 읽기/쓰기가 가능하다

## BRAM Instance

```SystemVerilog
blk_mem_gen_0 instance_name (
  .clka(clka),   
  .ena(ena),     
  .wea(wea),      
  .addra(addra),
  .dina(dina),    
  .clkb(clkb),  
  .enb(enb),     
  .addrb(addrb),  
  .doutb(doutb) 
);
```

## BRAM 동작 방식

Simple Dual Port BRAM은 읽기 포트(A)와 쓰기 포트(B)가 분리되어 있다.

### 읽기 포트 (Port A)

| 포트 | 설명 |
|---|---|
| `clka` | 읽기 클락 |
| `ena` | 읽기 활성화. 1이면 해당 클락에 `addra` 주소의 데이터를 읽음 |
| `addra` | 읽기 주소 |
| `douta` | 읽기 데이터 출력. `ena`가 1인 클락 다음 클락에 데이터가 출력됨 (1 클락 레이턴시) |

### 쓰기 포트 (Port B)

| 포트 | 설명 |
|---|---|
| `clkb` | 쓰기 클락 |
| `enb` | 쓰기 활성화. 1이면 해당 클락에 쓰기 동작 수행 |
| `web` | 쓰기 활성화 (byte enable). `enb`와 함께 1이어야 실제 쓰기 발생 |
| `addrb` | 쓰기 주소 |
| `dinb` | 쓰기 데이터 |

### 읽기 타이밍

BRAM은 **1 클락 레이턴시**가 존재한다. `ena`를 1로 올린 다음 클락에 `douta`에 데이터가 출력된다.

```wavedrom
{signal: [
  {name: "clka",  wave: "p......"},
  {name: "ena",   wave: "0.10..."},
  {name: "addra", wave: "x.3x...", data: ["addr"]},
  {name: "douta", wave: "x..4x..", data: ["data"]}
],
config: {hscale: 2}}
```

따라서 act_loader FSM에서 주소를 올린 뒤 **1 클락 후에** 데이터를 읽어야 한다.

### 쓰기 타이밍

`enb`와 `web`이 모두 1인 클락에 `addrb` 주소에 `dinb` 데이터가 즉시 저장된다.
```wavedrom
{signal: [
  {name: "clkb",  wave: "p......"},
  {name: "enb",   wave: "0.10..."},
  {name: "web",   wave: "0.10..."},
  {name: "addrb", wave: "x.3x...", data: ["addr"]},
  {name: "dinb",  wave: "x.4x...", data: ["data"]},
  {},
  {name: "BRAM",  wave: "x..4x..", data: ["data 저장"]}
],
config: {hscale: 2}}
```

### Data Packing

RAMB36은 한 번에 최대 72bit를 읽을 수 있다. 8-bit ACT_W 기준으로 16-lane vector를 한 번에 읽으려면 128bit가 필요하다. Vivado Block Memory Generator에서 데이터 폭을 **128bit**로 설정하면 내부적으로 BRAM 2개를 자동으로 묶어 한 클락에 16개의 값을 동시에 읽을 수 있다.

Activation BRAM word는 다음처럼 `ROWS`개 lane으로 pack한다.

| 비트        | 데이터 |
| --------- | ------ |
| [7:0]     | `A[m_base + 0][k]` |
| [15:8]    | `A[m_base + 1][k]` |
| ...       | ... |
| [127:120] | `A[m_base + 15][k]` |

Weight BRAM도 같은 방식으로 `COLS`개 lane을 pack한다.

| 비트        | 데이터 |
| --------- | ------ |
| [7:0]     | `B[k][n_base + 0]` |
| [15:8]    | `B[k][n_base + 1]` |
| ...       | ... |
| [127:120] | `B[k][n_base + 15]` |

결과 C는 ACC_W가 32bit이므로 같은 column의 16개 row를 한 word에 pack하려면 512bit가 필요하다.

| 비트        | 데이터 |
| --------- | ------ |
| [31:0]    | `C[m_base + 0][n_base + col]` |
| [63:32]   | `C[m_base + 1][n_base + col]` |
| ...       | ... |
| [511:480] | `C[m_base + 15][n_base + col]` |

이 pack format은 OS/WS 공통 C layout으로 사용할 수 있다.
OS는 `acc[row][col]`가 tile 안에 모두 준비된 뒤 이 word를 바로 만들 수 있다.
WS는 결과가 stream으로 나오기 때문에 같은 word를 만들기 위해 deskewing과 buffering이 필요하다.

## BRAM Loader
### 동작 흐름

1. 상위 FSM이 `en_i`와 `addr_i`를 설정
2. 해당 클락에 BRAM 읽기 요청 (`bram_en_o`, `bram_addr_o` 출력)
3. 1클락 후 `bram_data_i`에 128bit 데이터 출력
4. `valid_o`가 1이 되면 `data_o[0]~data_o[15]`에 unpack된 데이터 유효

### 포트 설명

|포트|방향|비트폭|설명|
|---|---|---|---|
|`aclk_i`|input|1-bit|클락|
|`aresetn_i`|input|1-bit|액티브 로우 리셋|
|`en_i`|input|1-bit|읽기 요청 신호|
|`addr_i`|input|ADDR_W|읽을 BRAM 주소|
|`bram_en_o`|output|1-bit|BRAM 읽기 활성화|
|`bram_addr_o`|output|ADDR_W|BRAM 읽기 주소|
|`bram_data_i`|input|BRAM_W|BRAM 읽기 데이터 (128-bit)|
|`data_o`|output|DATA_W × ROWS|unpack된 출력 데이터|
|`valid_o`|output|1-bit|데이터 유효 신호 (en_i 1클락 지연)|

### bram_loader.sv

```SystemVerilog
module bram_loader #(
    parameter int ROWS   = 16,
    parameter int DATA_W = 8,
    parameter int BRAM_W = 128,
    parameter int ADDR_W = 10
) (
    input  logic              aclk_i,
    input  logic              aresetn_i,
    input  logic              en_i,               // 읽기 요청
    input  logic [ADDR_W-1:0] addr_i,
    // BRAM 인터페이스
    output logic              bram_en_o,
    output logic [ADDR_W-1:0] bram_addr_o,
    input  logic [BRAM_W-1:0] bram_data_i,
    // 출력
    output logic [DATA_W-1:0] data_o     [ROWS],
    output logic              valid_o             // bram_en 1클락 지연
);

  assign bram_en_o   = en_i;
  assign bram_addr_o = addr_i;

  // valid: en_i 1클락 지연
  always_ff @(posedge aclk_i) begin
    if (!aresetn_i) valid_o <= 0;
    else valid_o <= en_i;
  end

  // 128bit unpack
  genvar i;
  generate
    for (i = 0; i < ROWS; i++) begin : g_unpack
      assign data_o[i] = bram_data_i[i*DATA_W+:DATA_W];
    end
  endgenerate

endmodule
```

## BRAM Storer

### 동작 흐름

1. 상위 FSM이 `valid_i`와 `addr_i`를 설정
2. `data_i[0]~data_i[15]`의 acc 값을 512bit로 pack
3. 해당 클락에 즉시 BRAM에 저장 (`bram_en_o`, `bram_we_o` 동시에 1)
4. 레이턴시 없이 저장 완료

### 포트 설명

| 포트            | 방향     | 비트폭           | 설명                |
| ------------- | ------ | ------------- | ----------------- |
| `aclk_i`      | input  | 1-bit         | 클락                |
| `aresetn_i`   | input  | 1-bit         | 액티브 로우 리셋         |
| `valid_i`     | input  | 1-bit         | 저장 요청 신호          |
| `addr_i`      | input  | ADDR_W        | 저장할 BRAM 주소       |
| `data_i`      | input  | DATA_W × COLS | 저장할 acc 데이터       |
| `bram_en_o`   | output | 1-bit         | BRAM 쓰기 활성화       |
| `bram_we_o`   | output | 1-bit         | BRAM 쓰기 인에이블      |
| `bram_addr_o` | output | ADDR_W        | BRAM 쓰기 주소        |
| `bram_data_o` | output | BRAM_W        | pack된 BRAM 쓰기 데이터 |

### bram_storer.sv
```SystemVerilog
module bram_storer #(
    parameter int COLS   = 16,
    parameter int DATA_W = 32,   // ACC_W
    parameter int BRAM_W = 512,  // COLS * DATA_W
    parameter int ADDR_W = 10
) (
    input  logic              aclk_i,
    input  logic              aresetn_i,
    input  logic              valid_i,            // 저장 요청
    input  logic [ADDR_W-1:0] addr_i,             // 저장 주소
    input  logic [DATA_W-1:0] data_i     [COLS],  // acc_o 입력
    // BRAM 인터페이스
    output logic              bram_en_o,
    output logic              bram_we_o,
    output logic [ADDR_W-1:0] bram_addr_o,
    output logic [BRAM_W-1:0] bram_data_o
);

  assign bram_en_o   = valid_i;
  assign bram_we_o   = valid_i;
  assign bram_addr_o = addr_i;

  // COLS개 DATA_W bit → BRAM_W bit pack
  genvar i;
  generate
    for (i = 0; i < COLS; i++) begin : g_pack
      assign bram_data_o[i*DATA_W+:DATA_W] = data_i[i];
    end
  endgenerate

endmodule
```
