Option Explicit

Dim WshShell, fso, projectDir, launcherScript, nodeExe
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcherScript = projectDir & "\scripts\launcher.mjs"

If Not fso.FileExists(launcherScript) Then
  MsgBox "No se encontro el script de arranque en:" & vbCrLf & launcherScript, 16, "OpenCharts - Error de instalacion"
  WScript.Quit 1
End If

Function FindNodeExe()
  Dim candidates, c, envPath, parts, p
  candidates = Array( _
    "C:\Program Files\nodejs\node.exe", _
    "C:\Program Files (x86)\nodejs\node.exe", _
    WshShell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\nodejs\node.exe", _
    WshShell.ExpandEnvironmentStrings("%APPDATA%") & "\nvm\current\node.exe" _
  )
  For Each c In candidates
    If fso.FileExists(c) Then
      FindNodeExe = c
      Exit Function
    End If
  Next

  envPath = WshShell.ExpandEnvironmentStrings("%PATH%")
  parts = Split(envPath, ";")
  For Each p In parts
    p = Trim(p)
    If Len(p) > 0 Then
      If Right(p, 1) = "\" Then p = Left(p, Len(p) - 1)
      If fso.FileExists(p & "\node.exe") Then
        FindNodeExe = p & "\node.exe"
        Exit Function
      End If
    End If
  Next

  FindNodeExe = ""
End Function

nodeExe = FindNodeExe()
If Len(nodeExe) = 0 Then
  MsgBox "No se encontro Node.js (node.exe) en este equipo." & vbCrLf & vbCrLf & _
         "Instala Node.js desde https://nodejs.org y vuelve a abrir OpenCharts.", _
         16, "OpenCharts - Falta Node.js"
  WScript.Quit 1
End If

WshShell.CurrentDirectory = projectDir
WshShell.Run """" & nodeExe & """ """ & launcherScript & """", 0, False
