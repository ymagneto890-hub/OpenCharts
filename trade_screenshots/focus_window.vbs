Set WshShell = CreateObject("WScript.Shell")
If WshShell.AppActivate("OpenCharts") Then
  WScript.Quit 0
Else
  WScript.Quit 1
End If