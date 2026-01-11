# Cursor 사이드 패널 500 에러 해결 가이드

Cursor의 사이드 패널(Source Control)에서 발생하는 "Bad Status 500" 에러를 해결하는 방법입니다.

## 원인

이 에러는 일반적으로 다음 원인으로 발생합니다:

1. **Git 인덱스 손상**: Git의 인덱스 파일(`.git/index`)이 손상되었을 때
2. **대용량 파일**: 100MB 이상의 파일이 Git에 포함되어 있을 때
3. **Git 설정 문제**: 파일 권한이나 줄바꿈 문자 설정 문제
4. **권한 문제**: 파일 시스템 접근 권한 문제
5. **Cursor 캐시 문제**: Cursor의 내부 캐시 문제

## 해결 방법

### 방법 1: 자동 수정 스크립트 실행 (권장)

1. `fix-git-500-error.bat` 파일을 더블클릭하거나 실행
2. 스크립트가 자동으로 다음 작업을 수행합니다:
   - Git 인덱스 백업 및 재구성
   - Git 설정 확인 및 수정
   - Git 캐시 정리
3. **Cursor를 완전히 종료하고 다시 시작**
4. 사이드 패널을 새로고침 (Ctrl+Shift+P → "Developer: Reload Window")

### 방법 2: 수동 수정

터미널에서 다음 명령어를 순서대로 실행:

```bash
# 1. Git 인덱스 재구성
git reset --mixed HEAD
git add -A

# 2. Git 설정 확인 및 수정
git config --local core.filemode false
git config --local core.autocrlf true

# 3. Git 캐시 정리
git gc --prune=now
```

### 방법 3: Cursor 캐시 초기화

1. Cursor 완전 종료
2. 다음 폴더 삭제:
   - Windows: `%APPDATA%\Cursor\Cache`
   - 또는 `%APPDATA%\Cursor\User\workspaceStorage`
3. Cursor 재시작

### 방법 4: Git 인덱스 완전 재생성

만약 위 방법이 작동하지 않으면:

```bash
# Git 인덱스 완전 삭제 및 재생성
rm .git/index
git reset HEAD
git add -A
```

### 방법 5: 대용량 파일 확인

```bash
# 대용량 파일 찾기
find . -type f -size +50M -not -path "./.git/*"

# 또는 PowerShell에서
Get-ChildItem -Recurse -File | Where-Object { $_.Length -gt 50MB } | Select-Object FullName, @{Name="Size(MB)";Expression={[math]::Round($_.Length/1MB,2)}}
```

만약 대용량 파일이 있다면 `.gitignore`에 추가하세요.

## 추가 확인 사항

### Git 상태 확인

```bash
git status
git fsck
```

### 파일 권한 확인

Windows에서는 일반적으로 문제가 되지 않지만, Git Bash를 사용하는 경우:

```bash
ls -la .git/index
```

### Cursor 로그 확인

1. Ctrl+Shift+P (또는 Cmd+Shift+P)
2. "Output: Show Output Channels" 검색
3. "Git" 또는 "Source Control" 선택
4. 에러 메시지 확인

## 예방 방법

1. **정기적인 Git 정리**:
   ```bash
   git gc --prune=now
   ```

2. **.gitignore 활용**: 불필요한 파일은 `.gitignore`에 추가

3. **대용량 파일 제외**: 100MB 이상의 파일은 Git LFS 사용 또는 제외

4. **Cursor 정기 업데이트**: 최신 버전으로 업데이트 유지

## 여전히 문제가 발생하면

1. Cursor 완전 재설치
2. Git 재설치
3. 프로젝트를 새로 클론

또는 Cursor 공식 GitHub 이슈 트래커에 보고:
https://github.com/getcursor/cursor/issues
