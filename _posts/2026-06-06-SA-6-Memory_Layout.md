---
title: 메모리 레이아웃
date: 2026-06-06 14:59:46 +0900
series: Systolic Array
series_order: 6
categories: Hardware
subcategory: RTL
tags:
  - SystemVerilog
  - Systolic_Array
---
## Memory Layout

### Tiling

Systolic Array는 전체 행렬을 한 번에 계산하지 않고 tile 단위로 행렬을 처리한다.

예를 들어 `ROWS = 2`, `COLS = 2`인 Systolic Array로 `4 x 4` 출력 행렬 C를 계산한다고 생각해보자.
`2 x 2` PE 배열은 한 번에 C의 `2 x 2` 영역만 계산할 수 있다.

![](/assets/images/Pasted%20image%2020260614142854.png)

따라서 메모리 읽기 순서는 단순한 row/column 순서가 아니라 tile 단위로 정해야 한다.
또한 내적 과정에 따라 Activation은 가로 방향으로, Weight는 세로 방향으로 읽는 것이 효율적이다.

첫 번째 타일 메모리 읽기 순서
- Activation : ($A_{0,0}, A_{0,1}$) → ($A_{1,0}, A_{1,1}$)
- Weight : ($B_{0,0}, B_{1,0}$) → ($B_{0,1}, B_{1,1}$)

![](/assets/images/Pasted%20image%2020260614143423.png)

앞으로 편의를 위해 타일을 위의 그림처럼 표현하겠다.

그렇다면 다음 tile은 어떻게 선택해야 할까? 이는 OS/WS 방식에 따라 달라진다.

## OS Tiling Order

OS는 output stationary, 즉 Result를 기준으로 연산 순서가 정해진다.
예를 들어 첫 번째 output tile은 K 방향으로 두 개의 tile product를 누적해서 만든다.

$$TC_{0,0} = TA_{0,0} \times TB_{0,0} + TA_{0,1} \times TB_{1,0}$$

이때 Activation은 $TA_{0,0}$ → $TA_{0,1}$ 순서로, Weight는 $TB_{0,0}$ → $TB_{1,0}$ 순서로 읽는다.

그 다음에는 $TC_{1,0}$이 아니라 $TC_{0,1}$을 먼저 계산한다.
인공지능 모델에서는 이전 layer의 Result가 다음 layer의 Activation이 되는 경우가 많기 때문에, output 저장 순서를 다음 GEMM의 Activation 읽기 순서와 맞추는 것이 좋다.
따라서 OS에서는 output tile을 row-major 순서로 계산한다.

```text
TC_{0,0} -> TC_{0,1} -> TC_{1,0} -> TC_{1,1}
```

$$TC_{0,0} = TA_{0,0} \times TB_{0,0} + TA_{0,1} \times TB_{1,0}$$
$$TC_{0,1} = TA_{0,0} \times TB_{0,1} + TA_{0,1} \times TB_{1,1}$$
$$TC_{1,0} = TA_{1,0} \times TB_{0,0} + TA_{1,1} \times TB_{1,0}$$
$$TC_{1,1} = TA_{1,0} \times TB_{0,1} + TA_{1,1} \times TB_{1,1}$$

이를 실제 read order로 나열하면 다음과 같다.

```text
Activation read order:
  TA_{0,0} -> TA_{0,1}
  -> TA_{0,0} -> TA_{0,1}
  -> TA_{1,0} -> TA_{1,1}
  -> TA_{1,0} -> TA_{1,1}

Weight read order:
  TB_{0,0} -> TB_{1,0}
  -> TB_{0,1} -> TB_{1,1}
  -> TB_{0,0} -> TB_{1,0}
  -> TB_{0,1} -> TB_{1,1}
```

## WS Tiling Order

WS는 weight stationary, 즉 Weight를 기준으로 연산 순서가 정해진다.
OS가 output tile을 하나씩 완성하는 방향이라면, WS는 한 번 로드한 weight tile을 최대한 재사용하는 방향으로 tile 순서를 잡는다.

예를 들어 $n\_tile = 0$에 해당하는 output column을 먼저 계산한다고 생각해보자.
이 column을 만들 때 필요한 weight는 $TB_{0,0}$과 $TB_{1,0}$이다.
이 두 weight tile은 $TC_{0,0}$과 $TC_{1,0}$을 계산할 때 모두 사용된다.

따라서 WS에서는 다음처럼 같은 weight tile을 고정해두고, Activation의 row tile을 바꿔가며 읽는 방식이 자연스럽다.

```text
n_tile 0 계산:
  TB_{0,0} load
    TA_{0,0} -> TC_{0,0} partial
    TA_{1,0} -> TC_{1,0} partial

  TB_{1,0} load
    TA_{0,1} -> TC_{0,0} complete
    TA_{1,1} -> TC_{1,0} complete
```

그 다음 $n\_tile = 1$도 같은 방식으로 계산한다.

```text
n_tile 1 계산:
  TB_{0,1} load
    TA_{0,0} -> TC_{0,1} partial
    TA_{1,0} -> TC_{1,1} partial

  TB_{1,1} load
    TA_{0,1} -> TC_{0,1} complete
    TA_{1,1} -> TC_{1,1} complete
```

이를 output tile이 완성되는 순서로 보면 다음과 같다.

```text
TC_{0,0} -> TC_{1,0} -> TC_{0,1} -> TC_{1,1}
```

이를 실제 read order로 나열하면 다음과 같다.

```text
Weight read order:
  TB_{0,0}
  -> TB_{1,0}
  -> TB_{0,1}
  -> TB_{1,1}

Activation read order:
  TA_{0,0} -> TA_{1,0}
  -> TA_{0,1} -> TA_{1,1}
  -> TA_{0,0} -> TA_{1,0}
  -> TA_{0,1} -> TA_{1,1}
```

OS와 비교하면 차이가 분명하다.
OS는 output 저장 순서를 기준으로 $TC_{0,0}$ → $TC_{0,1}$ → $TC_{1,0}$ → $TC_{1,1}$ 순서로 움직인다.
반면 WS는 weight 재사용을 기준으로 $TC_{0,0}$ → $TC_{1,0}$ → $TC_{0,1}$ → $TC_{1,1}$ 순서로 움직인다.

