---
title: "[Systolic Array] 1. 동작 원리"
date: 2026-05-31
categories:
  - Hardware
  - RTL
tags:
  - SystemVerilog
  - Systolic_Array
---
## Systolic Array란?

Systolic Array는 PE(Processing Element)들이 격자 형태로 배열되어, 데이터를 옆으로 흘리면서 연산하는 구조입니다. CPU/GPU와 달리 메모리 접근 없이 PE 간 직접 데이터를 전달해 메모리 병목을 줄입니다.

![SA](/assets/images/Systolic_Array_4x4.png)


## GEMM과의 관계 

Systolic Array의 핵심 목적은 행렬 곱셈(GEMM) 가속입니다. 

$$C = A \times B$$ 

- A: 입력 행렬 (왼쪽에서 오른쪽으로 흐름)
- B: 가중치 행렬 (위에서 아래로 흐름) 
- C: 출력 행렬 (각 PE에 누적)

## Dataflow 종류 

데이터를 어디에 고정하느냐에 따라 세 가지로 나뉩니다.

| Dataflow          | 고정 데이터 | 특징          |
| ----------------- | ------ | ----------- |
| Output Stationary | 출력(C)  | 부분합 누적      |
| Weight Stationary | 가중치(B) | 가중치 재사용 극대화 |
| Input Stationary  | 입력(A)  | 입력 재사용 극대화  |

이 시리즈에서는 **Output Stationary**와 **Weight Stationary**를 구현합니다. 

## PE 동작 

PE 하나는 다음 연산을 수행합니다

$$acc \mathrel{+}= a \times b$$

- `a`: 왼쪽에서 들어온 입력값 → 오른쪽으로 전달
- `b`: 위에서 들어온 가중치값 → 아래로 전달
- `acc`: 부분합 누적

## Output Stationary vs Weight Stationary 미리보기

두 방식의 차이는 **acc를 어디에 두느냐**입니다.

**Output Stationary**: acc를 PE 안에 고정합니다. a와 b가 PE를 통과하며 흘러가고, 부분합이 같은 PE에 계속 누적됩니다. 제어 로직이 단순해 구현 난이도가 낮습니다.

**Weight Stationary**: b(가중치)를 PE 안에 고정합니다. 가중치를 한 번 로드하면 여러 입력에 재사용할 수 있어 메모리 접근을 줄입니다. LLM 추론처럼 동일한 가중치로 반복 연산하는 경우에 유리합니다.

두 방식은 데이터 흐름 방향과 버퍼 설계가 완전히 달라집니다. 다음 포스트부터 PE 설계를 시작으로 각각 직접 구현해보겠습니다.