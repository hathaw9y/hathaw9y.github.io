---
title: "[Systolic Array] 0. 시작하며 - Systolic Array 설계"
date: 2026-05-30 00:00:00 +0900
categories:
  - RTL
  - Hardware
tags:
  - SystemVerilog
  - Systolic_Array
---


## 왜 Systolic Array인가? 
LLM 추론의 핵심은 행렬 곱셈(GEMM)입니다. 문제는 연산 자체가 아니라 **메모리 접근 비용**입니다. DRAM에서 데이터를 한 번 읽는 에너지는 MAC 연산 하나의 수백 배에 달합니다. 즉, 아무리 빠른 연산기를 만들어도 데이터를 매번 메모리에서 가져온다면 에너지와 시간 대부분이 메모리 접근에 낭비됩니다. 
Systolic Array는 이 문제를 PE 간 직접 데이터 전달로 해결합니다. 한 번 읽은 데이터를 옆 PE로 흘려보내며 재사용하기 때문에 메모리 접근 횟수를 극적으로 줄일 수 있습니다.

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
 
## 이 글을 쓰는 이유 

Systolic Array를 FPGA 타겟으로 SystemVerilog로 구현한 레퍼런스가 거의 없어 많이 힘들었습니다. 이 시리즈가 같은 어려움을 겪는 분들께 조금이나마 도움이 되길 바랍니다.