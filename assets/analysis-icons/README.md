# 분석 Top 아이콘

시안
- 식사: `assets/analysis-icons-colored.png`
- 간식: `assets/analysis-icons-snack-cyan.png`

## 재생성

```bash
python3 scripts/crop-analysis-icons-from-cyan.py
# 간식 시안 크롭은 동일 탐지 로직으로 analysis-icons-snack-cyan.png 사용
node scripts/embed-analysis-icons.mjs
```

- 크롭 결과: `assets/analysis-icons/*.png`
- 앱 표시용 임베드: `js/analytics/analysis-icon-assets.js` (data URI — 경로 깨짐 방지)

## 파일 접두사

| 접두사 | 항목 |
|--------|------|
| `how-*` | 식사 · 어떻게 |
| `what-*` | 식사 · 무엇을 |
| `with-*` | 함께/누구와 |
| `rating-*` | 만족도 (별 개수) |
| `satiety-*` | 포만감 |
| `snack-when-*` | 간식 · 언제 |
| `snack-type-*` | 간식 · 무엇을 |
| `snack-place-*` | 간식 · 어디서 |

