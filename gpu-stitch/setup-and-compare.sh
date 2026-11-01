#!/usr/bin/env bash
# On an NVIDIA Pod: builds gpu-stitch, then runs it and the CPU stitch on the same file and prints speed, size and quality.
#   bash setup-and-compare.sh input.360 [seconds]
set -euo pipefail
SRC=$1
SECONDS_ARG=${2:-20}
cd "$(dirname "$0")"

if ! command -v nvcc >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq nvidia-cuda-toolkit ffmpeg libavcodec-dev libavformat-dev libavutil-dev
fi
# PTX only, so the driver compiles the kernels for whatever card this is, Blackwell too.
nvcc -O3 --std=c++17 -arch=compute_75 -code=compute_75 -x cu main.cu -o gpu-stitch -lavformat -lavcodec -lavutil

W=$(mktemp -d)
read -r A B < <(ffprobe -v error -select_streams v -show_entries stream=index,codec_name,width -of csv=p=0 "$SRC" | awk -F, '$2=="hevc" && $3>=4096 {printf "%s ", $1}'; echo)
FPS=$(ffprobe -v error -select_streams v:0 -show_entries stream=avg_frame_rate -of csv=p=0 "$SRC")
FRAMES=$(python3 -c "n,d='$FPS'.split('/');print(round($SECONDS_ARG*int(n)/int(d)))")
FACE=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$SRC")
OVER=$([ "$FACE" = 1920 ] && echo 384 || echo 128)
BLEND=$((OVER / 2)); SCALED=$((BLEND * 3 / 2)); SLICE=$(((FACE - SCALED) / 2)); CX=$((SLICE * 2 + BLEND * 2)); RX=$((CX + FACE)); OW=$((FACE * 3)); OH=$((OW / 2)); D=$((BLEND + 1))
EXPR="if(between(X,0,$BLEND),(p((X+$BLEND),Y)*(((X+1))/$D))+(p(X,Y)*(($D-((X+1)))/$D)),p(X,Y))"
GEQ="geq=lum='$EXPR':cb='$EXPR':cr='$EXPR'"
side() { echo "[$1]crop=$SLICE:$FACE:x=$3:y=0,format=yuvj420p[$2l];[$1b]crop=$((BLEND * 2)):$FACE:x=$(($3 + SLICE)):y=0,format=yuvj420p,$GEQ,crop=$BLEND:$FACE:x=0:y=0,format=yuvj420p,scale=$SCALED:$FACE[$2o];[$1c]crop=$SLICE:$FACE:x=$(($3 + SLICE + BLEND * 2)):y=0,format=yuvj420p[$2r];[$2l][$2o][$2r]hstack=3[$2]"; }
lens() { echo "[0:$1]trim=end_frame=$FRAMES,setpts=PTS-STARTPTS,split=7[$2a][$2ab][$2ac][$2d][$2e][$2eb][$2ec];$(side $2a $2L 0);[$2d]crop=$FACE:$FACE:$CX:0[$2C];$(side $2e $2R $RX);[$2L][$2C][$2R]hstack=3[$2]"; }
GRAPH="$(lens "$A" f);$(lens "$B" k);[f][k]vstack[eac];[eac]v360=input=eac:output=equirect:interp=cubic:w=$OW:h=$OH:yaw=0:pitch=0:roll=0[out]"

run_cpu() {
  local start end; start=$(date +%s.%N)
  ffmpeg -hide_banner -loglevel error -y -i "$SRC" -filter_complex "$GRAPH" -map '[out]' -frames:v "$FRAMES" "$@"
  end=$(date +%s.%N)
  python3 -c "w=$end-$start;print(f'  {$FRAMES} frames  wall {w:.1f}s  {$FRAMES/w:.1f} fps')"
}
score() {
  local f="[0:v]setpts=N/30/TB,scale=out_range=pc,format=yuvj420p[a];[1:v]setpts=N/30/TB,format=yuvj420p[b];[a][b]"
  echo "  size $(stat -c %s "$1") bytes  $(ffmpeg -hide_banner -nostats -i "$1" -i "$W/ref.mkv" -lavfi "${f}psnr" -f null - </dev/null 2>&1 | grep -oE 'PSNR y:[0-9.]+')  SSIM $(ffmpeg -hide_banner -nostats -i "$1" -i "$W/ref.mkv" -lavfi "${f}ssim" -f null - </dev/null 2>&1 | grep -oE 'All:[0-9.]+')"
}

echo "== lossless reference (CPU)"
run_cpu -c:v libx264 -preset ultrafast -qp 0 -pix_fmt yuvj420p "$W/ref.mkv"
echo "== CPU x264 veryfast (the server's stitch)"
run_cpu -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p "$W/cpu.mp4"
score "$W/cpu.mp4"
echo "== gpu-stitch"
./gpu-stitch "$SRC" "$W/gpu.mp4" "$SECONDS_ARG" 26
score "$W/gpu.mp4"
rm -rf "$W"
