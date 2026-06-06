---
permalink: /about/
title: "About"
---

안녕하세요. 저는 NPU, RTL 설계, LLM quantization에 관심을 두고 공부하고 구현하는 민수홍입니다.

이 블로그는 읽은 내용을 단순히 요약하기보다, 직접 구현하고 부딪히면서 얻은 생각을 정리하기 위해 만들었습니다. 하드웨어 구조를 이해하고, RTL로 옮기고, 실제 동작과 병목을 확인하는 과정을 기록합니다.

## Interests

- NPU architecture
- Systolic array and GEMM acceleration
- SystemVerilog and RTL implementation
- FPGA prototyping
- LLM inference and quantization

## Writing

글은 가능한 한 다시 꺼내 쓸 수 있게 작성하려고 합니다. 개념 설명만 남기기보다 왜 그런 선택을 했는지, 구현하면서 어떤 문제가 있었는지, 다음에 같은 문제를 만났을 때 무엇을 확인해야 하는지를 함께 적습니다.

현재는 Systolic Array를 중심으로 PE 설계, dataflow, RTL 구현, FPGA 환경에서의 검증 흐름을 정리하고 있습니다.

## Current Focus

최근에는 LLM 추론에서 반복적으로 등장하는 행렬 연산을 하드웨어 관점에서 어떻게 효율적으로 처리할 수 있는지에 관심이 있습니다. 특히 Systolic Array 구조, dataflow 선택, PE 내부 누산 방식, 메모리 접근 패턴을 중심으로 공부하고 있습니다.

## What You Can Expect

이 블로그에는 완성된 결과만 올리기보다, 구현 과정에서 생긴 시행착오와 판단 기준을 함께 남기려고 합니다.

- 논문이나 자료를 읽고 이해한 내용
- RTL 구현 중 마주친 설계 선택지
- 시뮬레이션과 디버깅 과정
- FPGA 환경에서의 검증 기록
- LLM inference 최적화와 quantization 관련 메모

## Contact

가벼운 질문이나 의견은 GitHub 또는 Instagram으로 남겨주셔도 좋습니다. 기술적인 내용은 가능하면 이 블로그의 글이나 GitHub 기록으로 이어질 수 있게 정리해보려 합니다.

## Links

- GitHub: [hathaw9y](https://github.com/hathaw9y)
- Instagram: [suhongmim](https://instagram.com/suhongmim)
