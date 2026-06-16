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

## OS Activation Memory Layout

OS에서 Activation은 `m_tile`을 기준으로 저장하고, 각 `m_tile` 내부에서는 K 방향으로 주소가 증가한다.
즉 같은 output row tile에서 필요한 Activation vector를 K 방향으로 연속 배치한다.

이전 예시에서 Activation BRAM은 다음처럼 저장된다.

![](/assets/images/Pasted%20image%2020260614171828.png)

주소식은 다음과 같다.

```text
A_addr = act_base + m_tile_idx * K + k
```

## OS Weight Memory Layout

OS에서 Weight는 `n_tile`을 기준으로 저장하고, 각 `n_tile` 내부에서는 K 방향으로 주소가 증가한다.
즉 같은 output column tile에서 필요한 Weight vector를 K 방향으로 연속 배치한다.

이전 예시에서 Weight BRAM은 다음처럼 저장된다.

![](/assets/images/Pasted%20image%2020260614170712.png)

주소식은 다음과 같다.

```text
B_addr = weight_base + n_tile * K + k
```

## WS Tiling Order

WS는 weight stationary, 즉 Weight를 기준으로 연산 순서가 정해진다.
다만 여기서 구현하는 WS FSM은 OS처럼 `ROWS x COLS` output tile 전체를 한 번에 만들지 않고, 결과 일부분만 계산한다.

이전 예시, `2 x 2` tile로 `4 x 4` matrix를 계산한다고 가정하자.

![](/assets/images/Pasted%20image%2020260614143423.png)

우선 Result `N Tile 0` 부터 연산한다.

```text
TB_{0,0} load
  TA_{0,0} Compute -> TC_{0,0} partial
  TA_{1,0} Compute -> TC_{1,0} partial

TB_{1,0} load
  TA_{0,1} Compute -> TC_{0,0} partial
  TA_{1,1} Compute -> TC_{1,0} partial
```

그 다음 Result `N Tile 1` 을 연산한다.

```text
TB_{0,1} load
  TA_{0,0} Compute -> TC_{0,1} partial
  TA_{1,0} Compute -> TC_{1,1} partial

TB_{1,1} load
  TA_{0,1} Compute -> TC_{0,1} partial
  TA_{1,1} Compute -> TC_{1,1} partial
```

이를 읽기 순서로 나열하면 다음과 같다.

```text
Activation read order:
  TA_{0,0} -> TA_{0,1}
  -> TA_{1,0} -> TA_{1,1}
  -> TA_{0,0} -> TA_{0,1}
  -> TA_{1,0} -> TA_{1,1}

Weight read order:
  TB_{0,0}
  -> TB_{1,0}
  -> TB_{0,1}
  -> TB_{1,1}
```

## WS Activation Memory Layout

WS에서 Activation은 OS와 다르게 저장한다.
OS는 `m_tile`을 기준으로 K 방향 주소가 증가했지만, WS는 `k_tile`을 기준으로 M 방향 주소가 증가한다.
즉 같은 K tile에 대해 모든 output row의 activation vector를 연속해서 저장한다.

이전 예시에서 Activation BRAM은 다음처럼 저장된다.

![](/assets/images/Pasted%20image%2020260614164258.png)

주소식은 다음과 같다.

```text
A_addr = act_base + (k_tile * M) + m_idx
```

`2 x 2` tile로 `4 x 4` matrix를 계산하면 `M = 4`, `k_tiles = 2`이다.
따라서 Activation BRAM은 다음처럼 해석할 수 있다.

```text
k_tile 0:
  address 0x00: A[row 0][k = 0:1]
  address 0x01: A[row 1][k = 0:1]
  address 0x02: A[row 2][k = 0:1]
  address 0x03: A[row 3][k = 0:1]

k_tile 1:
  address 0x04: A[row 0][k = 2:3]
  address 0x05: A[row 1][k = 2:3]
  address 0x06: A[row 2][k = 2:3]
  address 0x07: A[row 3][k = 2:3]
```

현재 WS FSM은 같은 `(m_idx, n_tile)`에 대해 K tile을 먼저 처리한다.
따라서 `m_idx = 0`일 때 Activation read sequence는 다음처럼 된다.

```text
m_idx 0, n_tile 0: 0x00 -> 0x04
m_idx 0, n_tile 1: 0x00 -> 0x04
m_idx 1, n_tile 0: 0x01 -> 0x05
m_idx 1, n_tile 1: 0x01 -> 0x05
```

## WS Weight Memory Layout

Weight 메모리 레이아웃은 기존 OS Memory Layout과 동일하다.
다만 차이점이라면 WS는 각 weight tile을 load 단계에서 PE 내부에 고정하기 위해 사용한다.

![](/assets/images/Pasted%20image%2020260614170712.png)

저장 주소식은 다음과 같다.

```text
B_addr = weight_base + n_tile * K + k
```
