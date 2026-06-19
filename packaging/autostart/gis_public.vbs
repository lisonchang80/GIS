' Silent logon-autostart for the GIS public server (no console window).
' Put a shortcut to this file in the Startup folder (shell:startup) to launch
' the GIS server automatically at login. The shared Cloudflare tunnel is started
' separately (it already autostarts for ClinScope) and routes gis.tinghaochang.com
' to this server via ~/.cloudflared/config.yml.
Set sh = CreateObject("WScript.Shell")
sh.Run """D:\Claude code\GIS\packaging\start_public.bat""", 0, False
