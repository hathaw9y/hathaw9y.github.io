---
title: "[Systolic Array] 1. 동작 원리"
date: 2026-05-31
categories:
  - Hardware
  - RTL
  - Systolic Array
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

## Output Stationary vs Weight Stationary 미리보기

두 방식의 차이는 **acc를 어디에 두느냐**이다.

**Output Stationary**는 `acc`를 PE 안에 고정한다. `a`와 `b`가 PE를 통과하며 흘러가고, 부분합이 같은 PE에 계속 누적된다. 하나의 출력 원소를 계산하는 동안 해당 PE가 그 결과를 책임지는 방식이다.

**Weight Stationary**는 `b` 또는 weight를 PE 안에 고정한다. 가중치를 한 번 로드하면 여러 입력에 재사용할 수 있어 메모리 접근을 줄인다. LLM 추론처럼 동일한 weight로 반복 연산하는 경우에 유리하다.

두 방식은 겉으로 보면 비슷한 2D PE 배열이지만, 실제 RTL에서는 데이터 흐름 방향과 버퍼 설계가 크게 달라진다. 다음 포스트에서는 이 배열의 가장 작은 단위인 PE부터 설계해보겠다.
