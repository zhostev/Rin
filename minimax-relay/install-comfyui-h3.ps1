<#
.SYNOPSIS
  3090 机器一键安装：ComfyUI + 越狱版 MiniMax-H3（本地视频生成后端）。

.DESCRIPTION
  在 Windows 3090 机器上以管理员/普通 PowerShell 运行：
    powershell -ExecutionPolicy Bypass -File install-comfyui-h3.ps1

  前置：先到 https://comfy.org/ 安装 ComfyUI Desktop（最新版，H3 支持已内置），
  本脚本只负责下载模型文件（约 42GB）并放到正确目录。

  模型组合（社区 3090 验证配方，tonyd2wild/MiniMax-H3-Local）：
    diffusion_models : minimax_h3_fl2v pruned int8_convrot（21GB，Comfy-Org/MiniMax-H3）
    text_encoders    : Heretic 越狱版 NVFP4（15.7GB，Ampere 上仿真运行，比 50 系慢）
    vae              : video fp16（5.21GB）+ audio fp32（605MB）

  之后手动步骤（脚本最后会打印）：
    1. ComfyUI 启动参数加 --disable-pinned-memory --fp16-intermediates
      （Desktop：设置 → 额外启动参数；portable：改 run_nvidia_gpu.bat）
    2. 浏览器打开 ComfyUI，用内置 MiniMax-H3 模板分别跑通文生/图生视频，
       CLIPLoader 类型选 minimax，并选越狱编码器
    3. 工作流模板已内置在仓库 minimax-relay/workflows/（h3-t2v.json、
       h3-i2v.json），直接用：relay 的 COMFYUI_WORKFLOW_T2V /
       COMFYUI_WORKFLOW_I2V 指向它们（无需手动从 ComfyUI 导出）
#>
param(
    [string]$ModelsRoot = (Join-Path $env:LOCALAPPDATA "Comfy-Desktop\ComfyUI-Shared\models")
)

$ErrorActionPreference = "Stop"

function Say($msg) { Write-Host "[h3-setup] $msg" }

# ---- 0. 环境检查 ----
$desktopExe = Join-Path $env:LOCALAPPDATA "Comfy-Desktop"
if (-not (Test-Path $ModelsRoot)) {
    Say "ERROR: 没找到 ComfyUI Desktop 模型目录：$ModelsRoot"
    Say "请先到 https://comfy.org/ 安装最新版 ComfyUI Desktop，装完再跑本脚本。"
    exit 1
}
$ramGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
Say "内存：${ramGB}GB（建议 32GB+，不足时把虚拟内存/页面文件设到 40GB+）"
if ($ramGB -lt 32) { Say "WARN: 内存偏小，生成时可能频繁 offload，速度会慢。" }
$freeGB = [math]::Round((Get-PSDrive C).Free / 1GB)
if ($freeGB -lt 70) { Say "WARN: C 盘剩余 ${freeGB}GB，模型共约 42GB，请确保空间足够。" }

$files = @(
    @{ repo = "Comfy-Org/MiniMax-H3"; path = "diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors";
       dest = "diffusion_models"; size = "21GB" },
    @{ repo = "Momoking/Qwen3-VL-32B-Heretic-MiniMax-H3-NVFP4"; path = "qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors";
       dest = "text_encoders"; size = "15.7GB" },
    @{ repo = "Comfy-Org/MiniMax-H3"; path = "vae/minimax_h3_video_vae_fp16.safetensors";
       dest = "vae"; size = "5.21GB" },
    @{ repo = "Comfy-Org/MiniMax-H3"; path = "vae/minimax_h3_audio_vae_fp32.safetensors";
       dest = "vae"; size = "605MB" }
)

foreach ($f in $files) {
    $dir = Join-Path $ModelsRoot $f.dest
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $name = Split-Path $f.path -Leaf
    $out = Join-Path $dir $name
    if (Test-Path $out) { Say "已存在，跳过：$name"; continue }
    $url = "https://huggingface.co/$($f.repo)/resolve/main/$($f.path)"
    Say "下载 ($($f.size))：$name"
    # curl 断点续传；失败抛错
    & curl.exe -fSL -C - --retry 3 -o $out $url
    if ($LASTEXITCODE -ne 0) { Say "ERROR: 下载失败 $url"; exit 1 }
}

Say "模型下载完成。"

# ---- workflows 目录 ----
$wfDir = Join-Path $PSScriptRoot "workflows"
New-Item -ItemType Directory -Force -Path $wfDir | Out-Null

@"

下一步（手动，约 10 分钟）：

1. ComfyUI 启动参数加上：
     --disable-pinned-memory --fp16-intermediates
   Desktop 版在设置里找"额外启动参数"；portable 版改 run_nvidia_gpu.bat。

2. 浏览器打开 ComfyUI（默认 http://127.0.0.1:8188），用内置 MiniMax-H3
   模板分别跑通文生视频和图生视频：
   - CLIPLoader 类型选 minimax，并选中 qwen3vl_32b_heretic_minimax_h3_nvfp4
   - 先用 5 秒 832x480 验证（3090 约 4～5 分钟出片）

3. 工作流模板已内置在仓库 minimax-relay/workflows/（h3-t2v.json、
   h3-i2v.json），把这两个文件拷到 $wfDir 即可，无需手动导出。
   （提示词 {{PROMPT}}、首帧 {{FIRST_FRAME_FILE}}、帧数 {{LENGTH}}
   由 relay 自动填充。）

4. relay 环境变量（/etc/rin-minimax-relay.env）：
     VIDEO_PROVIDER=comfyui
     COMFYUI_URL=http://127.0.0.1:8188
     COMFYUI_WORKFLOW_T2V=$wfDir\h3-t2v.json
     COMFYUI_WORKFLOW_I2V=$wfDir\h3-i2v.json
   relay 与 ComfyUI 在同一台机器时 COMFYUI_URL 不用改；
   不在同一台时改成 ComfyUI 所在机器的内网地址:8188。

5. 重启 relay，curl http://127.0.0.1:18081/health 应显示 "provider":"comfyui"。
"@
