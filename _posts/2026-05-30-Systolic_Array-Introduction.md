---
title: "[Systolic Array] 0. 시작하며 - 16x16 Systolic Array 설계"
date: 2026-05-30 00:00:00 +0900
categories:
  - RTL
  - Hardware
tags:
  - SystemVerilog
  - Systolic_Array
---
## 왜 Systolic Array인가?

대부분의 NPU 가속기는 행렬 연산을 효율적으로 처리하기 위해 Systolic Array 구조를 사용합니다.
Google TPU를 비롯해 상용 NPU 대부분이 이 구조를 기반으로 합니다.
행렬 곱셈은 LLM 추론의 핵심 연산이며, Systolic Array는 데이터 재사용률을 극대화해 메모리 병목을 줄이는 데 효과적입니다.

## 사전 지식

이 시리즈는 아래 개념을 알고 있다고 가정합니다.
모르신다면 링크를 먼저 읽어보세요.

- [Systolic Array란?](https://en.wikipedia.org/wiki/Systolic_array)
- [Google TPU 논문](https://arxiv.org/abs/1704.04760)
- [SystemVerilog 기초](https://hdlbits.01xz.net)
- FPGA 기본 개념 (Vivado 사용 경험 권장)

## 목표

16×16 Systolic Array를 SystemVerilog로 직접 구현하고,
Output Stationary와 Weight Stationary 두 가지 dataflow를 비교합니다.

## 시리즈 구성

1. PE (Processing Element) 설계
2. Output Stationary 구현
3. Weight Stationary 구현
4. 두 방식 비교 및 분석

## 타겟 환경

- FPGA: ZCU104
- FPGA 프레임워크: PYNQ 
- 툴: Vivado 2024.1
- 언어: SystemVerilog
- 
## 이 글을 쓰는 이유

직접 구현하면서 Systolic Array를 FPGA 타겟으로 SystemVerilog로 구현한 레퍼런스가 거의 없어 많이 힘들었습니다. 이 시리즈가 같은 어려움을 겪는 분들께 조금이나마 도움이 되길 바랍니다.