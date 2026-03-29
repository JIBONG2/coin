Option Explicit
Dim sh, fso, projectDir
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
' 이 .vbs 파일이 있는 폴더 = 봇 프로젝트 루트
projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FolderExists(projectDir) Then
  MsgBox "프로젝트 폴더를 찾을 수 없습니다.", vbCritical, "LTC 봇"
  WScript.Quit 1
End If
sh.CurrentDirectory = projectDir
' /k = 봇이 꺼져도 창이 남아 오류 로그 확인 가능
sh.Run "cmd /k chcp 65001 >nul & npm start", 1, False
