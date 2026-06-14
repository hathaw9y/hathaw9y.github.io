---
title: 동작 원리
date: 2026-05-31
series: Systolic Array
series_order: 1
categories: Hardware
subcategory: RTL
tags:
  - SystemVerilog
  - Systolic_Array
---
## Systolic Array란?

Systolic Array는 PE(Processing Element)들이 격자 형태로 배열되어, 데이터를 일정한 방향으로 흘려보내며 연산하는 구조다. 핵심은 데이터를 메모리에서 매번 다시 읽는 대신, PE 사이에서 직접 전달하며 재사용하는 것이다.

이름의 `systolic`은 심장이 박동하듯 데이터가 배열 안에서 규칙적으로 이동하는 모습을 비유한 표현이다. 각 PE는 매 cycle마다 입력을 받고, 곱셈과 누산을 수행한 뒤, 필요한 데이터를 이웃 PE로 넘긴다.

![SA](/assets/images/Systolic_Array_4x4.png)


## GEMM과의 관계 

Systolic Array가 자주 등장하는 대표적인 이유는 행렬 곱셈(GEMM)을 효율적으로 가속할 수 있기 때문이다.

$$C = A \times B$$ 

행렬 곱셈은 다음과 같이 같은 형태의 MAC 연산을 반복한다.

$$C_{i,j} = \sum_k A_{i,k} \times B_{k,j}$$

이때 하나의 $A_{i,k}$ 값은 같은 row의 여러 출력 계산에 사용되고, 하나의 $B_{k,j}$ 값은 같은 column의 여러 출력 계산에 사용된다. 즉, 같은 데이터를 여러 번 재사용할 수 있다.

Systolic Array는 이 재사용 패턴을 하드웨어 구조로 직접 표현한다.

- A: 왼쪽에서 오른쪽으로 흐른다.
- B: 위에서 아래로 흐른다.
- C: 각 PE에서 부분합으로 누적된다.

데이터가 배열을 통과하는 동안 여러 PE가 동시에 MAC을 수행하므로, 메모리 접근을 줄이면서 높은 throughput을 얻을 수 있다.

## Dataflow 종류 

Systolic Array를 설계할 때 가장 먼저 정해야 하는 것은 어떤 데이터를 PE 안에 오래 머물게 할지다. 이를 dataflow라고 부른다. 데이터를 어디에 고정하느냐에 따라 대표적으로 세 가지 방식이 있다.

| Dataflow          | 고정 데이터 | 특징          |
| ----------------- | ------ | ----------- |
| Output Stationary | 출력(C)  | 부분합 누적      |
| Weight Stationary | 가중치(B) | 가중치 재사용 극대화 |
| Input Stationary  | 입력(A)  | 입력 재사용 극대화  |

이 시리즈에서는 **Output Stationary**와 **Weight Stationary**를 구현한다. 두 방식은 같은 GEMM을 계산하지만, PE 내부 register 구성과 valid 신호, buffer 설계가 달라진다.

## PE 동작 

PE 하나는 기본적으로 다음 연산을 수행한다.

$$acc \mathrel{+}= a \times b$$

- `a`: 왼쪽에서 들어온 입력값. 다음 PE로 전달된다.
- `b`: 위에서 들어온 가중치값. 다음 PE로 전달되거나 PE 내부에 저장된다.
- `acc`: 부분합 누적

PE 자체는 단순하다. 어려운 부분은 이 단순한 PE를 배열로 연결했을 때, 각 cycle에 올바른 `a`와 `b`가 같은 PE에서 만나도록 timing을 맞추는 것이다.

## Output Stationary vs Weight Stationary 

두 방식의 차이는 **acc를 어디에 두느냐**이다.

**Output Stationary**는 `acc`를 PE 안에 고정한다. `a`와 `b`가 PE를 통과하며 흘러가고, 부분합이 같은 PE에 계속 누적된다. 하나의 출력 원소를 계산하는 동안 해당 PE가 그 결과를 책임지는 방식이다.

**Weight Stationary**는 `b` 또는 weight를 PE 안에 고정한다. 가중치를 한 번 로드하면 여러 입력에 재사용할 수 있어 메모리 접근을 줄인다. LLM 추론처럼 동일한 weight로 반복 연산하는 경우에 유리하다.

두 방식은 겉으로 보면 비슷한 2D PE 배열이지만, 실제 RTL에서는 데이터 흐름 방향과 버퍼 설계가 크게 달라진다. 다음 포스트에서는 이 배열의 가장 작은 단위인 PE부터 설계해보겠다.

이 시리즈에서는 전체 구조를 먼저 잡고 세부 모듈로 내려가는 **Top-Down 설계**를 기준으로 설명한다.
먼저 Systolic Array Engine이 SoC 안에서 어떤 역할을 하는지 보고, 그 다음 Engine 내부를 FSM, BRAM Loader/Store, Systolic Array로 나눈다.

하지만 RTL 구현은 반대로 **Bottom-Up**으로 진행한다.
가장 작은 단위인 PE를 먼저 만들고, PE를 2D 배열로 연결한 뒤, skewing, BRAM interface, FSM을 차례대로 붙여 최종 Engine으로 확장한다.
즉 설계는 위에서 아래로 이해하고, 구현은 아래에서 위로 쌓아 올리는 방식이다.

## Overall Architecture
![](/assets/images/Pasted%20image%2020260613123049.png)

위 그림은 Systolic Array를 단독 연산 블록이 아니라, 실제 SoC 안에서 어떻게 사용되는지 나타낸 전체 구조다. 크게 PS(Processing System)와 PL(Programmable Logic) 영역으로 나눌 수 있다. PS에는 CPU와 DDR이 있고, PL에는 Controller, DMA Engine, BRAM, Systolic Array Engine이 배치된다.

빨간색 화살표는 제어 경로를 의미한다. 
1. CPU는 Controller의 register를 설정하여 연산 크기, 시작 주소, 동작 모드 등을 전달하고
2. Controller는 Systolic Array Engine과 DMA Engine에 start 신호를 보내거나 done 상태를 확인한다. 
즉, CPU가 모든 연산을 직접 수행하는 것이 아니라, 연산에 필요한 설정과 실행 순서만 제어한다.

파란색 화살표는 데이터 경로를 의미한다. 
1. CPU는 먼저 입력 행렬과 가중치 행렬을 DDR에 준비한다. 
2. DMA Engine이 DDR에 있는 데이터를 읽어 PL 내부의 BRAM으로 옮긴다
3. Systolic Array Engine은 BRAM에 저장된 데이터를 읽어 MAC 연산을 수행한다
4. 연산 결과는 다시 BRAM에 저장되고
5. 최종 결과는 DMA Engine을 통해 DDR로 되돌아간다.

이 구조에서 BRAM은 Systolic Array Engine에 가까운 local buffer 역할을 한다. 모든 cycle마다 DDR에 직접 접근하면 latency와 bandwidth 병목이 커지기 때문에, DMA를 통해 필요한 데이터를 미리 BRAM에 적재한 뒤 Systolic Array가 빠르게 재사용할 수 있도록 한다. 결국 CPU는 제어를 담당하고, DDR은 큰 데이터 저장소 역할을 하며, DMA와 BRAM은 데이터 이동과 buffering을 담당하고, Systolic Array Engine은 실제 GEMM 연산을 수행한다.

전체 동작 순서는 다음과 같다.

1. CPU가 입력 행렬과 가중치 행렬을 DDR에 저장한다.
2. CPU가 PL의 Controller에 연산 시작 신호와 필요한 설정값을 전달한다.
3. Controller는 시작 신호를 수신한 뒤 DMA Engine을 제어하여 DDR의 데이터를 BRAM으로 가져온다.
4. BRAM에 필요한 데이터가 준비되면 Controller가 Systolic Array Engine을 실행한다.
5. Systolic Array Engine은 BRAM에서 데이터를 읽어 연산하고, 결과를 다시 BRAM에 저장한다.
6. 연산이 끝나면 DMA Engine이 BRAM의 결과 값을 DDR로 전송한다.
7. 모든 데이터 전송이 완료되면 Controller가 CPU에 종료 상태를 알린다.

즉, CPU는 연산 데이터를 DDR에 준비하고 시작 명령을 내린 뒤 결과가 끝나기를 기다린다. 실제 데이터 이동은 DMA Engine이 담당하고, 실제 MAC 연산은 Systolic Array Engine이 담당한다. 이렇게 역할을 나누면 CPU가 직접 대량의 데이터를 옮기거나 연산하지 않아도 되므로, PL 내부의 병렬 연산 구조를 효율적으로 사용할 수 있다.

### Systolic Array Engine
![](/assets/images/Pasted%20image%2020260613140740.png)

위 그림은 PL 내부의 **Systolic Array Engine**만 확대해서 나타낸 구조다.
Engine은 크게 네 개의 블록으로 나눌 수 있다.

| 블록 | 역할 |
|---|---|
| `Systolic Array FSM` | 전체 연산 순서 제어 |
| `BRAM Loader` | BRAM에서 activation/weight를 읽어 배열 입력 형태로 변환 |
| `Systolic Array` | PE 배열에서 실제 MAC 연산 수행 |
| `BRAM Store` | Systolic Array 결과를 BRAM에 다시 저장 |

그림의 빨간색 화살표는 **제어 경로**다.
외부 `Controller`는 `Systolic Array FSM`에 start, matrix size, base address 같은 설정값을 전달한다.
FSM은 이 정보를 바탕으로 내부 모듈들을 순서대로 실행한다.

```text
Controller
  -> Systolic Array FSM
  -> BRAM Loader / Systolic Array / BRAM Store 제어
```

FSM이 직접 연산을 수행하는 것은 아니다.
FSM은 어느 cycle에 BRAM을 읽을지, 언제 Systolic Array에 valid를 줄지, 언제 결과를 저장할지를 결정한다.
즉 Engine 내부의 지휘자 역할을 한다.

파란색 화살표는 **데이터 경로**다.
연산 데이터는 BRAM에서 시작해 Loader를 거쳐 Systolic Array로 들어가고, 계산 결과는 Store를 거쳐 다시 BRAM으로 돌아간다.

```text
BRAM
  -> BRAM Loader
  -> Systolic Array
  -> BRAM Store
  -> BRAM
```

`BRAM Loader`는 BRAM에 저장된 데이터를 Systolic Array가 한 cycle에 소비할 수 있는 vector 형태로 읽어온다.
예를 들어 16x16 배열이라면 한 cycle에 여러 row의 activation과 여러 column의 weight가 함께 공급되어야 한다.
따라서 Loader는 단순히 메모리를 읽는 모듈이 아니라, 메모리 layout을 array input layout으로 바꿔주는 역할도 한다.

`Systolic Array`는 Engine의 계산 코어다.
OS 방식에서는 각 PE가 출력 부분합을 내부에 누산하고, WS 방식에서는 각 PE가 weight를 저장한 뒤 acc를 아래로 흘려보낸다.
두 방식 모두 같은 GEMM을 계산하지만, 내부 데이터 흐름이 다르기 때문에 FSM과 Loader/Store timing도 함께 달라진다.

`BRAM Store`는 Systolic Array에서 나온 결과를 다시 BRAM layout에 맞춰 저장한다.
배열 내부의 결과 형태와 BRAM에 저장해야 하는 형태가 항상 같지는 않기 때문에, Store 단계에서도 valid와 address 제어가 필요하다.

정리하면 Systolic Array Engine은 다음 순서로 동작한다.

1. `Controller`가 FSM에 연산 설정을 전달한다.
2. FSM이 `BRAM Loader`를 동작시켜 activation/weight를 읽는다.
3. Loader가 읽어온 데이터를 Systolic Array 입력으로 공급한다.
4. Systolic Array가 MAC 연산을 수행한다.
5. FSM이 `BRAM Store`를 동작시켜 결과를 BRAM에 저장한다.
6. 모든 tile 연산이 끝나면 FSM이 `done`을 Controller에 전달한다.

이 그림은 이후 글들의 기준점이다.
다음 글부터는 Bottom-Up 방식으로 PE, OS/WS 배열, skewing, BRAM Loader/Store, FSM을 하나씩 구현하면서 이 Engine 구조를 완성한다.
