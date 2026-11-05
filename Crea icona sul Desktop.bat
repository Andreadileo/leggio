@echo off
cd /d "%~dp0"
powershell -NoProfile -Command "$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Leggio Personale.lnk'); $s.TargetPath=(Join-Path $PWD 'Avvia Leggio.bat'); $s.IconLocation=(Join-Path $PWD 'leggio.ico'); $s.WorkingDirectory=$PWD.Path; $s.Description='Apri Leggio'; $s.Save()"
echo.
echo  Fatto! Sul Desktop trovi l'icona "Leggio Personale".
echo  Cliccala per aprire il software.
echo.
pause
