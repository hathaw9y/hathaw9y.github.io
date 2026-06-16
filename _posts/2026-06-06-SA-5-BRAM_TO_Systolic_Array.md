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

## Vivado에서 BRAM IP 생성하기

BRAM은 RTL에서 memory array를 작성해서 synthesis가 추론하도록 만들 수도 있다.
하지만 이번 설계처럼 Systolic Array Engine, DMA adapter, Vivado Block Design을 같이 연결할 예정이라면 `Block Memory Generator` IP를 만들어 포트 형태를 고정해두는 편이 편하다.

Vivado에서는 다음 순서로 만든다.

```text
Flow Navigator
  -> IP Catalog
  -> Block Memory Generator 검색
  -> Customize IP
```

처음 생성할 때는 component name을 `blk_mem_gen_0` 그대로 두지 말고, 용도에 맞게 나누는 것이 좋다.

| BRAM | 예시 이름 | 역할 |
|---|---|---|
| Activation BRAM | `act_bram` | Activation vector word 저장 |
| Weight BRAM | `weight_bram` | Weight vector word 저장 |
| Accumulator BRAM | `acc_bram` | 계산 결과 word 저장 |

### Basic 설정

`Block Memory Generator` 설정 화면에서 기본값을 다음처럼 맞춘다.

![](/assets/images/bram_ip_basic.png)

| 항목 | 설정 |
|---|---|
| Interface Type | `Native` |
| Memory Type | `Simple Dual Port RAM` |
| ECC | 사용하지 않음 |
| Common Clock | 사용 |
| Enable Port Type | `Use ENA Pin`, `Use ENB Pin` |

여기서 `Native`를 선택하면 AXI BRAM Controller 같은 버스 wrapper가 붙지 않고, RTL에서 바로 사용할 수 있는 `addr`, `din`, `dout`, `we`, `en` 포트가 나온다.
이번 글의 `bram_loader`, `bram_storer`는 이 native BRAM port를 직접 제어하는 구조다.

위 화면은 `W128_D512_BLK_MEM`이라는 이름으로 만든 예시다.
이 이름은 필수 규칙은 아니지만, width와 depth를 이름에 넣어두면 나중에 Block Design이나 RTL instance를 볼 때 헷갈리지 않는다.

```text
W128_D512_BLK_MEM
  -> data width = 128 bit
  -> depth      = 512 words
```

왼쪽 IP symbol에 `dina[127:0]`, `addra[8:0]`, `wea[0:0]`가 보인다.
이는 현재 Port A가 다음처럼 만들어졌다는 뜻이다.

| 신호 | 의미 |
|---|---|
| `dina[127:0]` | 한 번에 쓰는 BRAM word가 128bit |
| `addra[8:0]` | 주소가 9bit이므로 0부터 511까지, 총 512 word 접근 가능 |
| `wea[0:0]` | byte write enable이 꺼져 있어 write enable이 1bit |

`Byte Write Enable`은 일단 끄는 것이 단순하다.
Systolic Array에서는 8bit activation 하나만 따로 쓰기보다, 16개 lane을 pack한 128bit word 전체를 한 번에 쓰는 구조가 더 자연스럽기 때문이다.
나중에 byte 단위 partial update가 필요해지면 그때 byte write enable을 켜면 된다.

`Common Clock`은 처음에는 켜는 것을 추천한다.
이번 구조에서는 DMA adapter, BRAM, Systolic Array Engine이 모두 같은 PL clock인 `aclk`에서 동작한다고 보고 설명하기 때문이다.
Common Clock을 켜면 read port와 write port가 같은 clock domain에 있으므로 simulation과 timing을 확인하기도 쉽다.
나중에 DMA/write side와 Engine/read side를 서로 다른 clock으로 나눌 계획이 있을 때만 Common Clock을 끄고 clock crossing 문제를 따로 다루면 된다.

`Simple Dual Port RAM`을 선택하면 한쪽 port는 write, 다른 port는 read로 사용한다.
이 글에서는 다음 기준으로 설명한다.

| Port | 용도 | 주요 신호 |
|---|---|---|
| Port A | write | `clka`, `ena`, `wea`, `addra`, `dina` |
| Port B | read | `clkb`, `enb`, `addrb`, `doutb` |

### Width와 Depth 정하기

BRAM의 data width는 Systolic Array가 한 cycle에 소비하거나 저장하는 packed word 폭과 맞춘다.
주소는 byte address가 아니라 **BRAM word address**다.
즉 width가 128bit이면 address 0 하나가 16byte word 하나를 가리킨다.

예를 들어 `ROWS = 16`, `COLS = 16`, `ACT_W = 8`, `WEIGHT_W = 8`, `ACC_W = 32`라면 다음처럼 잡을 수 있다.

| BRAM | Data Width | 한 주소에 들어가는 데이터 |
|---|---:|---|
| Activation BRAM | `ROWS * ACT_W = 128` bit | activation 16개 |
| Weight BRAM | `COLS * WEIGHT_W = 128` bit | weight 16개 |
| Accumulator BRAM (OS) | `ROWS * ACC_W = 512` bit | 같은 column의 output 16개 |
| Accumulator BRAM (WS) | `COLS * ACC_W = 512` bit | 같은 row의 output 16개 |

여기서 스크린샷 예시는 `W128_D512_BLK_MEM`이다.
즉 128bit word를 512개 저장하는 BRAM이라는 뜻이다.

```text
전체 저장 용량 = 128 bit/word * 512 word
              = 65536 bit
              = 64 Kb
```

Activation BRAM과 Weight BRAM은 둘 다 8bit 데이터 16개를 한 word에 pack하므로 `W128_D512_BLK_MEM`으로 만들 수 있다.
반면 Accumulator BRAM은 32bit 결과 16개를 한 word에 pack하므로 width가 512bit가 된다.
현재 예시는 `ROWS = COLS = 16`이라 OS와 WS 모두 512bit가 되지만, 의미는 다르다.
OS는 한 column에 대한 `ROWS`개 결과를 저장하고, WS는 한 output row에 대한 `COLS`개 결과를 저장한다.

따라서 같은 depth 512 예시를 기준으로 하면 IP를 다음처럼 두 종류로 만들 수 있다.

| IP 이름 예시 | 용도 | Width | Depth | 한 주소에 들어가는 데이터 |
|---|---|---:|---:|---|
| `W128_D512_BLK_MEM` | Activation / Weight | 128 bit | 512 | 8bit lane 16개 |
| `W512_D512_BLK_MEM` | Accumulator | 512 bit | 512 | 32bit lane 16개 |

`W512_D512_BLK_MEM`도 설정 방법은 같다.
`Native`, `Simple Dual Port RAM`, `Common Clock`, `No ECC`, `Byte Write Enable off`를 유지하고, Port A/B width만 512로 바꾸면 된다.
다만 512bit port는 BRAM primitive를 width 방향으로 더 많이 묶기 때문에 128bit BRAM보다 resource를 더 많이 사용한다.

왜 depth를 512로 잡았을까?
먼저 중요한 점은 `512`가 BRAM의 고정 depth라는 뜻은 아니라는 것이다.
Vivado Block Memory Generator의 depth는 **이 IP가 몇 개의 word를 저장할 것인지**를 정하는 값이다.
따라서 실제 설계에서는 뒤에서 계산하는 `act_depth`, `weight_depth`, `acc_depth`처럼 필요한 word 개수에 맞춰 정해야 한다.

그럼에도 캡처 예시를 `D512`로 둔 이유는, 넓은 BRAM port를 처음 만들 때 FPGA 내부 구조를 설명하기 좋기 때문이다.
Xilinx BRAM primitive는 data width 설정에 따라 한 primitive가 제공하는 유효 depth가 달라진다.
36Kb BRAM 하나를 넓은 word width로 사용할수록 address depth는 작아지고, 더 넓은 port가 필요하면 Vivado가 여러 primitive를 width 방향으로 묶는다.

```text
128bit x 512 words
  -> 여러 BRAM primitive를 width 방향으로 묶어 한 word를 구성
  -> 실제 primitive 분할은 Vivado가 선택
```

즉 `D512`는 캡처를 위한 작은 예시다.
더 많은 데이터를 저장해야 하면 depth를 1024, 2048, 16384처럼 더 크게 잡을 수 있고, Vivado가 BRAM primitive를 depth 방향으로도 추가로 묶는다.
실제 최대 matrix를 BRAM에 모두 담으려면 아래에서 계산한 depth로 IP를 다시 만들어야 한다.

Port A는 write port로 사용한다.
스크린샷 예시처럼 128bit word를 512개 저장하는 경우에는 다음처럼 설정한다.

![](/assets/images/bram_ip_port_a.png)

| 항목 | 설정 |
|---|---|
| Port A Width | `128` |
| Port A Depth | `512` |
| Operating Mode | `No Change` |
| Enable Port Type | `Use ENA Pin` |
| Port A Optional Output Registers | 사용하지 않음 |

Port B는 read port로 사용한다.
Port A와 같은 word 단위로 읽을 것이므로 width와 depth를 동일하게 맞춘다.

![](/assets/images/bram_ip_port_b.png)

| 항목 | 설정 |
|---|---|
| Port B Width | `128` |
| Port B Depth | `512` |
| Operating Mode | `Read First` |
| Enable Port Type | `Use ENB Pin` |
| Port B Optional Output Registers | 현재 loader 기준으로는 사용하지 않음 |

위 캡처에서는 `Primitive Output Register`가 체크되어 있다.
이 캡처는 옵션 위치를 보여주기 위한 화면이고, 현재 RTL 설정으로는 체크를 해제하는 것이 맞다.
즉 실제로 생성할 때는 `Primitive Output Register`와 `Core Output Register`를 모두 꺼둔다.
이 옵션을 켜면 BRAM 출력에 register stage가 추가되어 read latency가 늘어난다.
현재 `bram_loader`는 read request 뒤 1 cycle 후에 `valid_o`를 내는 구조이므로, 그대로 쓰려면 `Primitive Output Register`와 `Core Output Register`를 모두 꺼야 한다.
반대로 output register를 켠 채로 쓰고 싶다면 `bram_loader`의 `valid_o` 지연도 그만큼 늘려야 한다.

Depth는 저장해야 하는 word 개수로 잡는다.
따라서 실제 설계에서 필요한 depth가 512보다 크면 IP 설정의 depth도 그만큼 키워야 한다.
예를 들어 OS layout에서 최대 행렬 크기를 `M_MAX = 256`, `N_MAX = 256`, `K_MAX = 1024`로 잡는다면 다음과 같다.

```text
act_depth    = ceil(M_MAX / ROWS) * K_MAX
weight_depth = ceil(N_MAX / COLS) * K_MAX
acc_depth    = ceil(M_MAX / ROWS) * ceil(N_MAX / COLS) * COLS
```

숫자로 대입하면 다음처럼 된다.

```text
act_depth    = ceil(256 / 16) * 1024      = 16384 words
weight_depth = ceil(256 / 16) * 1024      = 16384 words
acc_depth    = 16 * 16 * 16               = 4096 words
```

Vivado IP 설정의 `Write Depth`에는 이 word 개수를 넣으면 된다.
`ADDR_W`는 이 depth를 표현할 수 있어야 하므로, RTL에서는 보통 다음처럼 잡는다.

```verilog
localparam int ACT_ADDR_W = $clog2(ACT_DEPTH);
```

이후 글에서 다루는 Memory Layout은 바로 이 word address 위에서 정의된다.
DMA가 DDR에서 데이터를 가져오더라도, 최종적으로 `axis_to_bram_writer`가 이 주소 순서대로 BRAM word를 써야 Engine이 올바르게 읽을 수 있다.

### Read Latency 확인

BRAM read는 동기식이라 address를 넣은 cycle에 바로 data가 나오지 않는다.
이 글의 loader는 **read latency 1 cycle**을 가정한다.

따라서 처음에는 IP 설정에서 추가 output register를 켜지 않는 편이 단순하다.
만약 `Primitive Output Register`나 `Core Output Register`를 켜서 read latency가 2 cycle 이상이 되면, `bram_loader`의 `valid_o`도 같은 cycle 수만큼 지연시켜야 한다.

## BRAM Instance

```verilog
act_bram u_act_bram (
  // Port A: write
  .clka (aclk),
  .ena  (act_bram_wr_en),
  .wea  (act_bram_wr_we),
  .addra(act_bram_wr_addr),
  .dina (act_bram_wr_data),

  // Port B: read
  .clkb (aclk),
  .enb  (act_bram_rd_en),
  .addrb(act_bram_rd_addr),
  .doutb(act_bram_rd_data)
);
```

## BRAM 동작 방식

Simple Dual Port BRAM은 쓰기 포트와 읽기 포트가 분리되어 있다.
위 instance 기준으로 Port A는 write, Port B는 read로 사용한다.

### 쓰기 포트 (Port A)

| 포트 | 설명 |
|---|---|
| `clka` | 쓰기 클락 |
| `ena` | 쓰기 port 활성화 |
| `wea` | 쓰기 활성화. `ena`와 함께 1이어야 실제 쓰기 발생 |
| `addra` | 쓰기 주소 |
| `dina` | 쓰기 데이터 |

`wea`의 폭은 IP 설정에 따라 달라진다.
byte write enable을 사용하지 않으면 보통 1bit로 두면 되고, byte write enable을 사용하면 `BRAM_W / 8` bit가 된다.

### 읽기 포트 (Port B)

| 포트 | 설명 |
|---|---|
| `clkb` | 읽기 클락 |
| `enb` | 읽기 활성화. 1이면 해당 클락에 `addrb` 주소의 데이터를 읽음 |
| `addrb` | 읽기 주소 |
| `doutb` | 읽기 데이터 출력. `enb`가 1인 클락 다음 클락에 데이터가 출력됨 (1 클락 레이턴시) |

### 읽기 타이밍

BRAM은 **1 클락 레이턴시**가 존재한다. `enb`를 1로 올린 다음 클락에 `doutb`에 데이터가 출력된다.

```wavedrom
{signal: [
  {name: "clkb",  wave: "p......"},
  {name: "enb",   wave: "0.10..."},
  {name: "addrb", wave: "x.3x...", data: ["addr"]},
  {name: "doutb", wave: "x..4x..", data: ["data"]}
],
config: {hscale: 2}}
```

따라서 act_loader FSM에서 주소를 올린 뒤 **1 클락 후에** 데이터를 읽어야 한다.

### 쓰기 타이밍

`ena`와 `wea`가 모두 1인 클락에 `addra` 주소에 `dina` 데이터가 저장된다.
```wavedrom
{signal: [
  {name: "clka",  wave: "p......"},
  {name: "ena",   wave: "0.10..."},
  {name: "wea",   wave: "0.10..."},
  {name: "addra", wave: "x.3x...", data: ["addr"]},
  {name: "dina",  wave: "x.4x...", data: ["data"]},
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

결과 C는 ACC_W가 32bit이므로 16개 결과를 한 word에 pack하려면 512bit가 필요하다.
다만 OS와 WS에서 한 word가 의미하는 방향이 다르다.

OS에서는 PE 배열 안에 `ROWS x COLS` tile 전체 결과가 남는다.
store 단계에서 column 하나를 선택하고, 그 column의 `ROWS`개 row 결과를 한 word로 pack한다.

| 비트        | 데이터 |
| --------- | ------ |
| [31:0]    | `C[m_base + 0][n_base + col]` |
| [63:32]   | `C[m_base + 1][n_base + col]` |
| ...       | ... |
| [511:480] | `C[m_base + 15][n_base + col]` |

WS에서는 한 번에 한 output row와 `COLS`개 column 결과가 나온다.
따라서 WS Accumulator BRAM word는 다음처럼 같은 row의 column lane을 pack한다.

| 비트        | 데이터 |
| --------- | ------ |
| [31:0]    | `C[m_idx][n_base + 0]` |
| [63:32]   | `C[m_idx][n_base + 1]` |
| ...       | ... |
| [511:480] | `C[m_idx][n_base + 15]` |

즉 둘 다 512bit BRAM을 쓸 수 있지만, address가 가리키는 output vector의 의미는 다르다.
이 차이를 기억해야 뒤의 OS/WS FSM에서 Accumulator BRAM 주소식을 헷갈리지 않는다.

## BRAM Loader
### 동작 흐름

아래 설명은 Activation/Weight용 128bit BRAM을 읽는 경우를 기준으로 한다.
모듈 자체는 `BRAM_W` parameter를 바꾸면 512bit Accumulator BRAM에도 사용할 수 있다.

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

```verilog
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
| `data_i`      | input  | DATA_W × LANES | 저장할 acc 데이터       |
| `bram_en_o`   | output | 1-bit         | BRAM 쓰기 활성화       |
| `bram_we_o`   | output | 1-bit         | BRAM 쓰기 인에이블      |
| `bram_addr_o` | output | ADDR_W        | BRAM 쓰기 주소        |
| `bram_data_o` | output | BRAM_W        | pack된 BRAM 쓰기 데이터 |

### bram_storer.sv
```verilog
module bram_storer #(
    parameter int LANES  = 16,
    parameter int DATA_W = 32,   // ACC_W
    parameter int BRAM_W = LANES * DATA_W,
    parameter int ADDR_W = 10
) (
    input  logic                     aclk_i,
    input  logic                     aresetn_i,
    input  logic                     valid_i,             // 저장 요청
    input  logic        [ADDR_W-1:0] addr_i,              // 저장 주소
    input  logic signed [DATA_W-1:0] data_i      [LANES], // lane별 저장 데이터
    // BRAM 인터페이스
    output logic                     bram_en_o,
    output logic                     bram_we_o,
    output logic        [ADDR_W-1:0] bram_addr_o,
    output logic        [BRAM_W-1:0] bram_data_o
);

  assign bram_en_o   = valid_i;
  assign bram_we_o   = valid_i;
  assign bram_addr_o = addr_i;

  // LANES개 DATA_W bit를 한 BRAM word로 pack한다.
  genvar i;
  generate
    for (i = 0; i < LANES; i++) begin : g_pack
      assign bram_data_o[i*DATA_W+:DATA_W] = data_i[i];
    end
  endgenerate

endmodule
```
