---
title: 시작하며 - Systolic Array 설계
date: 2026-05-30 00:00:00 +0900
series: Systolic Array
series_order: 0
categories: Hardware
subcategory: RTL
tags:
  - SystemVerilog
  - Systolic_Array
---
## 왜 Systolic Array인가? 

LLM 추론의 핵심 연산은 행렬 곱셈(GEMM)이다. 행렬 곱셈은 MAC(Multiply-Accumulate) 연산을 매우 많이 반복하기 때문에, 겉으로 보기에는 연산기를 많이 넣으면 성능이 좋아질 것처럼 보인다.

하지만 실제 병목은 연산 자체보다 **메모리 접근 비용**에 있는 경우가 많다. DRAM에서 데이터를 한 번 읽는 에너지는 MAC 연산 하나보다 훨씬 크다. 즉, 아무리 빠른 연산기를 만들어도 데이터를 매번 메모리에서 가져온다면 에너지와 시간 대부분이 데이터 이동에 낭비된다.

Systolic Array는 이 문제를 PE(Processing Element) 간 직접 데이터 전달로 줄인다. 한 번 읽은 데이터를 옆 PE로 흘려보내며 재사용하기 때문에 메모리 접근 횟수를 줄이고, 여러 PE가 같은 타이밍으로 동시에 연산할 수 있다.

이 시리즈에서는 먼저 Systolic Array가 어떤 문제를 해결하는지 큰 그림을 잡고, 이후 PE 하나의 동작부터 16×16 배열 구현까지 차례대로 내려가며 정리한다.

## 사전 지식

이 시리즈는 아래 개념을 알고 있다고 가정한다.
모르신다면 링크를 먼저 읽는 걸 추천한다.

- [Google TPU 논문](https://arxiv.org/abs/1704.04760)
- [SystemVerilog 기초](https://hdlbits.01xz.net)
- FPGA 기본 개념 (Vivado 사용 경험 권장)

## 목표

최종 목표는 16×16 Systolic Array를 SystemVerilog로 직접 구현하고, Output Stationary와 Weight Stationary 두 가지 dataflow를 비교하는 것이다.

단순히 RTL 코드를 완성하는 것보다 다음 질문에 답하는 것을 목표로 한다.

- Systolic Array는 왜 GEMM에 적합한가?
- PE는 어떤 값을 저장하고 어떤 값을 전달해야 하는가?
- Output Stationary와 Weight Stationary는 구조적으로 무엇이 다른가?
- FPGA 위에서 구현할 때 어떤 제약이 생기는가?

## 시리즈 구성

1. Systolic Array 동작 원리
2. PE(Processing Element) 설계
3. Output Stationary 구현
4. Weight Stationary 구현
5. 두 방식 비교 및 분석

## 타겟 환경

- FPGA: ZCU104
- FPGA 프레임워크: PYNQ 
- 툴: Vivado 2024.1
- 언어: SystemVerilog
 
## 이 글을 쓰는 이유 

Systolic Array를 FPGA 타겟으로 SystemVerilog로 구현한 레퍼런스가 많지 않아 시행착오가 많았다. 특히 개념 설명은 많지만, dataflow 선택이 RTL 구조에 어떻게 반영되는지까지 이어지는 자료는 찾기 어려웠다.

이 시리즈가 같은 어려움을 겪는 분들께 조금이나마 도움이 되길 바란다.
