# Heading 1
## Heading 2
### Heading 3

Some **bold**, *italic*, ~~strike~~, `inline code`, and a [link](https://example.com).
Money stays text: it costs $5 and $6 today. Inline code keeps dollars: `$not_math$`.

Inline math: $E = mc^2$, $\alpha_i + \beta^{2}$, and \(\nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_0}\).
Underscores inside math are not emphasis: $a_1 * b_2 * c_3$.

$$
\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}
$$

\[
\mathcal{L}(\theta) = -\sum_{i=1}^{N} \log p_\theta(y_i \mid x_i)
\]

```math
\begin{aligned}
f(x) &= x^2 \\
f'(x) &= 2x
\end{aligned}
```

- item one
- item two
  1. nested ordered
  2. another
- [x] done task
- [ ] open task

> A blockquote with $x^2$ inside.

| Symbol | Meaning | Value |
|---|:---:|--:|
| $\pi$ | pi | 3.14159 |
| $e$ | Euler | 2.71828 |

```python
def add(a, b):
    """Return the sum."""
    return a + b
```

```bash
for f in *.py; do python "$f"; done
```

Raw HTML is shown, not run: <script>alert(1)</script> <img src=x onerror=alert(1)>

---

Done.
