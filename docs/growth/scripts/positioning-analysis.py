# -*- coding: utf-8 -*-
"""밀로그 모먼트 내보내기(xlsx) 포지셔닝 검증 분석.

사용법: python3 docs/growth/scripts/positioning-analysis.py [xlsx 경로]
의존성 없음(표준 라이브러리만). 결과는 같은 폴더의 positioning-result.json 에도 저장된다.
분석 배경과 해석은 docs/growth/01-positioning-validation.md 를 본다.
"""
import zipfile, re, json, random, statistics as st
from collections import Counter, defaultdict
from datetime import date

import sys, os
P=sys.argv[1] if len(sys.argv)>1 else os.path.join(os.path.dirname(__file__),'../../../.00_마케팅/900_분석데이터/mealog-moments-20260713-20260812-202608121800.xlsx')
z=zipfile.ZipFile(P); xml=z.read('xl/worksheets/sheet1.xml').decode('utf-8',errors='ignore')
rows=re.findall(r'<row[^>]*>.*?</row>', xml, re.S)
def cells(r):
    out=[]
    for c in re.findall(r'<c[^>]*>.*?</c>|<c[^>]*/>', r, re.S):
        t=re.search(r'<t[^>]*>(.*?)</t>', c, re.S); v=re.search(r'<v>(.*?)</v>', c, re.S)
        out.append(t.group(1) if t else (v.group(1) if v else ''))
    return out
H=cells(rows[0]); idx={h:i for i,h in enumerate(H)}
data=[c for c in (cells(r) for r in rows[1:]) if len(c)>=22]
def g(d,k): return d[idx[k]]
def pd(s):
    y,m,dd=[int(x) for x in s.strip('.').split('.')]; return date(y,m,dd)
START,END=date(2026,7,13),date(2026,8,12)

# ── 신호 정의 ─────────────────────────────────────────────
HEALTH_TXT=re.compile(r'혈당|식후\s*\d|공복|\d{2}(\.\d)?\s*kg|몸무게|체중|약\s*먹|영양제|단백질|유산소|붓기|생리|칼로리|kcal|당뇨|인슐린|단식|간헐적')
PORTION=re.compile(r'\d+\s*(숟|스푼|입|개|조각|장|g|ml|컵|잔|공기|인분)|1/2|1/3|반\s*(개|공기|그릇)')
STORY=re.compile(r'[ㅋㅎ]{2,}|\.\.\.|\(\.\.\.\)|ㅠ|ㅜ|맛있|맛집|여행|생일|기분|날씨|덥|시원|상쾌|여유|셰프|웨이팅|줄서|데이트|회식')

users=defaultdict(lambda: dict(recs=0,days=set(),photo=0,share=0,com=0,health=0,portion=0,story=0,
    where=0,who=0,sat=0,full=0,journal=0,metric=0,first=END,last=START,hours=[]))
for d in data:
    u=g(d,'작성자UID'); U=users[u]; dt=pd(g(d,'날짜'))
    U['recs']+=1; U['days'].add(dt)
    U['first']=min(U['first'],dt); U['last']=max(U['last'],dt)
    if g(d,'사진수') not in ('','0'): U['photo']+=1
    if g(d,'공유여부')=='Y': U['share']+=1
    txt=(g(d,'코멘트')+' '+g(d,'무엇을_상세')).strip()
    if g(d,'코멘트').strip(): U['com']+=1
    if HEALTH_TXT.search(txt): U['health']+=1
    if PORTION.search(g(d,'무엇을_상세')): U['portion']+=1
    if STORY.search(g(d,'코멘트')): U['story']+=1
    if g(d,'어디서').strip(): U['where']+=1
    if g(d,'누구와').strip(): U['who']+=1
    if g(d,'만족도').strip(): U['sat']+=1
    if g(d,'포만감').strip(): U['full']+=1
    if g(d,'유형').startswith('하루기록'): U['journal']+=1
    if g(d,'하루기록지표').strip(): U['metric']+=1
    if g(d,'시간'): U['hours'].append(int(g(d,'시간')[:2]))

# ── 사용자 분류 (B 점수 / A 점수) ───────────────────────────
rowsU=[]
for u,U in users.items():
    n=U['recs']
    b_score = (U['health']>=2) + (U['portion']/n>=0.25 and U['portion']>=3) + (U['metric']>=1) + (U['full']/n>=0.3 and U['full']>=3)
    a_score = (U['story']>=2) + (U['where']/n>=0.3 and U['where']>=3) + (U['who']/n>=0.3 and U['who']>=3) + (U['photo']/n>=0.8 and U['photo']>=5)
    if b_score>=2 and b_score>a_score: seg='B'
    elif a_score>=2 and a_score>b_score: seg='A'
    elif b_score>=1 and a_score==0: seg='B-lean'
    elif a_score>=1 and b_score==0: seg='A-lean'
    else: seg='U'
    rowsU.append(dict(uid=u,seg=seg,b=b_score,a=a_score,recs=n,days=len(U['days']),
        photo_rate=U['photo']/n,share=U['share'],first=U['first'],last=U['last'],
        new=(U['first']>START),alive_lastweek=(U['last']>=date(2026,8,6)),
        span=(U['last']-U['first']).days+1, hours=U['hours']))

seg_cnt=Counter(r['seg'] for r in rowsU)
def summarize(rs):
    if not rs: return {}
    return dict(n=len(rs),
        recs_med=st.median([r['recs'] for r in rs]), recs_mean=round(st.mean([r['recs'] for r in rs]),1),
        days_med=st.median([r['days'] for r in rs]), days_mean=round(st.mean([r['days'] for r in rs]),1),
        recs_per_day=round(sum(r['recs'] for r in rs)/sum(r['days'] for r in rs),2),
        photo_rate=round(st.mean([r['photo_rate'] for r in rs]),2),
        alive=round(100*sum(r['alive_lastweek'] for r in rs)/len(rs)),
        share_users=sum(1 for r in rs if r['share']>0),
        total_recs=sum(r['recs'] for r in rs))

def perm_test(x,y,it=20000,seed=1):
    random.seed(seed); obs=st.mean(x)-st.mean(y); pool=x+y; k=len(x); c=0
    for _ in range(it):
        random.shuffle(pool); 
        if abs(st.mean(pool[:k])-st.mean(pool[k:]))>=abs(obs): c+=1
    return round(obs,2), round(c/it,4)

B=[r for r in rowsU if r['seg'] in('B','B-lean')]; A=[r for r in rowsU if r['seg'] in('A','A-lean')]
Bs=[r for r in rowsU if r['seg']=='B']; As=[r for r in rowsU if r['seg']=='A']
out=dict(total_users=len(rowsU), total_recs=len(data), segments=dict(seg_cnt))
out['broad']=dict(B=summarize(B),A=summarize(A),U=summarize([r for r in rowsU if r['seg']=='U']))
out['strict']=dict(B=summarize(Bs),A=summarize(As))
out['tests_broad']=dict(
    days=perm_test([r['days'] for r in B],[r['days'] for r in A]),
    recs=perm_test([r['recs'] for r in B],[r['recs'] for r in A]),
    alive=perm_test([1.0*r['alive_lastweek'] for r in B],[1.0*r['alive_lastweek'] for r in A]))
out['tests_strict']=dict(
    days=perm_test([r['days'] for r in Bs],[r['days'] for r in As]),
    recs=perm_test([r['recs'] for r in Bs],[r['recs'] for r in As]))

# ── 신규 사용자 코호트 리텐션 ─────────────────────────────
new=[r for r in rowsU if r['new']]
def ret(rs,k):  # 첫 기록 후 k일 이상 지난 시점에 활동이 있는가 (관측 가능한 사용자만)
    elig=[r for r in rs if (END-r['first']).days>=k]
    if not elig: return None
    hit=sum(1 for r in elig if any((dd-r['first']).days>=k for dd in users[r['uid']]['days']))
    return dict(k=k,eligible=len(elig),retained=hit,rate=round(100*hit/len(elig)))
out['new_cohort']=dict(n=len(new), D1=ret(new,1),D3=ret(new,3),D7=ret(new,7),D14=ret(new,14),D21=ret(new,21))
out['new_cohort_by_seg']={s:dict(n=len([r for r in new if r['seg'] in ss]),
    D7=ret([r for r in new if r['seg'] in ss],7), D14=ret([r for r in new if r['seg'] in ss],14))
    for s,ss in [('B',('B','B-lean')),('A',('A','A-lean')),('U',('U',))]}
# 첫날 기록 수 vs 생존
first_day_recs={}
for r in new:
    fd=r['first']; first_day_recs[r['uid']]=sum(1 for d in data if g(d,'작성자UID')==r['uid'] and pd(g(d,'날짜'))==fd)
grp=defaultdict(list)
for r in new:
    k='1건' if first_day_recs[r['uid']]==1 else ('2건' if first_day_recs[r['uid']]==2 else '3건+')
    grp[k].append(r)
out['first_day_activation']={k:ret(v,7) for k,v in grp.items()}

# ── 시간/요일 패턴 ──────────────────────────────────────
hours=Counter(); wd=Counter()
for d in data:
    if g(d,'시간'): hours[int(g(d,'시간')[:2])]+=1
    wd[pd(g(d,'날짜')).weekday()]+=1
out['hour_top']=hours.most_common(6); out['weekday']=[wd[i] for i in range(7)]
# 첫 기록 요일 (신규 유입 요일)
out['new_first_weekday']=Counter(r['first'].weekday() for r in new)
# 제공자
out['provider_users']=dict(Counter(r['uid'].split('_')[0] if '_' in r['uid'] else 'other' for r in rowsU))
# 사진/공유
out['photo_rate_all']=round(100*sum(1 for d in data if g(d,'사진수') not in('','0'))/len(data),1)
out['share_rate_all']=round(100*sum(1 for d in data if g(d,'공유여부')=='Y')/len(data),1)
out['share_users']=sum(1 for r in rowsU if r['share']>0)
# 상위 집중도
c=sorted((r['recs'] for r in rowsU),reverse=True)
out['top10_share']=round(100*sum(c[:10])/len(data),1)
# 세그먼트별 대표 신호 예시 (PII 없이)
out['examples']={'B':[],'A':[]}
for d in data:
    u=g(d,'작성자UID'); s=next((r['seg'] for r in rowsU if r['uid']==u),None)
    t=g(d,'코멘트') or g(d,'무엇을_상세')
    if s=='B' and len(out['examples']['B'])<8 and (HEALTH_TXT.search(t) or PORTION.search(t)): out['examples']['B'].append(t[:40])
    if s=='A' and len(out['examples']['A'])<8 and STORY.search(t): out['examples']['A'].append(t[:40])

json.dump(out,open(os.path.join(os.path.dirname(__file__),'positioning-result.json'),'w'),ensure_ascii=False,indent=1,default=str)
print(json.dumps(out,ensure_ascii=False,indent=1,default=str))
