# PowerShell 오류 해결 가이드

Cursor의 사이드 패널에서 Git 커밋할 때 PowerShell 오류가 발생하는 문제를 해결하는 방법입니다.

## 문제 원인

Cursor가 Git 명령어를 실행할 때 PowerShell을 사용하는데, PowerShell 프로파일에 문제가 있어서 발생하는 오류입니다.

## 해결 방법

### 방법 1: PowerShell 프로파일 수정 (권장)

1. `fix-powershell.bat` 파일을 **관리자 권한으로** 실행
2. 스크립트가 자동으로 프로파일을 백업하고 재생성합니다
3. Cursor를 재시작합니다
4. 이제 사이드 패널에서 커밋이 정상적으로 작동합니다

### 방법 2: Git Bash 사용 설정

1. Cursor에서 `Ctrl + Shift + P` (또는 `Cmd + Shift + P` on Mac)
2. "Terminal: Select Default Profile" 검색
3. "Git Bash" 선택
4. 이제 터미널이 Git Bash로 열립니다

### 방법 3: 배치 파일 사용 (임시 해결책)

PowerShell 오류가 계속 발생한다면, 다음 배치 파일을 사용하세요:

- `simple-commit.bat` - 간단한 커밋 및 푸시
- `commit-and-deploy.bat` - 상세한 커밋 및 배포

### 방법 4: 수동 커밋 (터미널에서)

터미널을 열어서 직접 명령어를 실행:

```bash
git add -A
git commit -m "커밋 메시지"
git push origin main
```

## 설정 파일

`.vscode/settings.json` 파일을 생성하여 Cursor 설정을 변경할 수 있습니다. 이 파일은 `.gitignore`에 포함되어 있어 Git에 커밋되지 않습니다 (개인 설정이므로 정상입니다).

## 추가 정보

- PowerShell 프로파일 위치: `$PROFILE.CurrentUserAllHosts`
- Git Bash 설치 필요: [Git for Windows](https://git-scm.com/download/win)
