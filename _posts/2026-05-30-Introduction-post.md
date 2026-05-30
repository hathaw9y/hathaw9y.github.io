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
- 툴: Vivado 2024.1
- 언어: SystemVerilog