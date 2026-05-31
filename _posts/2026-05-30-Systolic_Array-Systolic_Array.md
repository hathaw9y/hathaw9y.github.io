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

![585](assets/images/systolic_array_4x4_dataflow%201.svg)

## GEMM과의 관계 
Systolic Array의 핵심 목적은 행렬 곱셈(GEMM) 가속입니다. 

$$C = A \times B$$ 
- A: 입력 행렬 (왼쪽에서 오른쪽으로 흐름)
- B: 가중치 행렬 (위에서 아래로 흐름) 
- C: 출력 행렬 (각 PE에 누적)

## Dataflow 종류 
데이터를 어디에 고정하느냐에 따라 세 가지로 나뉩니다.

| Dataflow          | 고정 데이터 | 특징            |
| ----------------- | ------ | ------------- |
| Output Stationary | 출력(C)  | 구현 단순, 부분합 누적 |
| Weight Stationary | 가중치(B) | 가중치 재사용 극대화   |
| Input Stationary  | 입력(A)  | 입력 재사용 극대화    |

이 시리즈에서는 **Output Stationary**와 **Weight Stationary**를 구현합니다. 
## PE 동작 
PE 하나는 다음 연산을 수행합니다

$$acc += a * b$$

- `a`: 왼쪽에서 들어온 입력값 → 오른쪽으로 전달
- `b`: 위에서 들어온 가중치값 → 아래로 전달
- `acc`: 부분합 누적
