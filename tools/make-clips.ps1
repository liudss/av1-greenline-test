<#
  Generate AV1 test clips that differ ONLY in frame height.

  Purpose: reproduce the Chromium / D3D11VideoDecoder "green line at frame edge"
  artifact without depending on any website. Every clip is 1920 wide, flat gray,
  BT.709 limited range, yuv420p, AV1 main profile -- i.e. the same properties as
  the Bilibili stream that triggered the bug (1920x886).

  Encoder must be libaom, not SVT-AV1: SVT silently rounds the height up to a
  multiple of 8 (886 -> 888, 890 -> 896), which would erase the very variable
  under test. libaom keeps any even height.

  Requires ffmpeg with libaom-av1 in PATH.
#>

$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$outDir = Join-Path $root 'clips'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# Height -> what the height exercises.
$heights = [ordered]@{
    886  = 'bilibili case, 2x443'
    888  = '8-aligned, not 16'
    890  = '2-aligned only'
    884  = '4-aligned, not 8'
    1080 = 'common 1080p, not 16-aligned'
    1088 = '16/64-aligned'
    720  = 'control 720p'
}

$rows = @()

foreach ($h in $heights.Keys) {
    $out = Join-Path $outDir "av1_1920x$h.mp4"
    $boxH = $h - 12

    # Flat mid gray + a dim inner border so any edge sampling error is obvious
    # and any non-gray row (green) is unambiguous.
    # Note: ${boxH} -- a bare $boxH: would be parsed as a scoped variable name.
    $filter = "color=c=0x808080:s=1920x${h}:r=30:d=3," +
              "drawbox=x=6:y=6:w=1908:h=${boxH}:color=0x404040@1:t=2"

    $args = @(
        '-y', '-v', 'error',
        '-f', 'lavfi', '-i', $filter,
        '-pix_fmt', 'yuv420p',
        '-c:v', 'libaom-av1', '-cpu-used', '8', '-crf', '50',
        '-row-mt', '1', '-g', '30',
        '-colorspace', 'bt709', '-color_primaries', 'bt709',
        '-color_trc', 'bt709', '-color_range', 'tv',
        '-movflags', '+faststart',
        $out
    )

    Write-Host ("encoding 1920x{0} ..." -f $h) -NoNewline
    & ffmpeg @args
    if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed for height $h" }

    # Verify the encoder kept the requested height -- this is the whole point.
    $probe = & ffprobe -v error -select_streams v:0 `
        -show_entries stream=width,height -of csv=p=0 $out
    $w, $actual = $probe.Split(',')
    $flag = if ([int]$actual -eq $h) { 'ok' } else { "MISMATCH (got $actual)" }
    Write-Host (" {0}, {1:N0} bytes" -f $flag, (Get-Item $out).Length)

    $rows += [pscustomobject]@{
        Name   = "av1_1920x$h.mp4"
        Width  = [int]$w
        Height = [int]$actual
        Mod16  = [int]$actual % 16
        KB     = [math]::Round((Get-Item $out).Length / 1KB, 1)
    }
}

Write-Host ''
$rows | Format-Table -AutoSize
