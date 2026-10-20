#!/bin/sh
##################################################################################
#    This file is part of System Monitor Gnome extension.
#    System Monitor Gnome extension is free software: you can redistribute it and/or modify
#    it under the terms of the GNU General Public License as published by
#    the Free Software Foundation, either version 3 of the License, or
#    (at your option) any later version.
#    System Monitor Gnome extension is distributed in the hope that it will be useful,
#    but WITHOUT ANY WARRANTY; without even the implied warranty of
#    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
#    GNU General Public License for more details.
#    You should have received a copy of the GNU General Public License
#    along with System Monitor.  If not, see <http://www.gnu.org/licenses/>.
#    Copyright 2017 Fran Glais, David King, indigohedgehog@github.
##################################################################################

##################################
#                                #
#   Check for GPU memory usage   #
#                                #
##################################

checkcommand()
{
	command -v "$1" > /dev/null 2>&1
}

GPU_INDEX=${1:-0}

# Check if NVIDIA GPU is present without running nvidia-smi --list-gpus
if checkcommand nvidia-smi && [ -d /sys/bus/pci/drivers/nvidia ]; then
	# If discrete GPU is currently suspended in RTD3, do not wake it up with nvidia-smi
	for pci_dev in /sys/bus/pci/drivers/nvidia/[0-9]*; do
		if [ -f "$pci_dev/power/runtime_status" ]; then
			if [ "$(cat "$pci_dev/power/runtime_status" 2>/dev/null)" = "suspended" ]; then
				echo "0"
				echo "0"
				echo "0"
				exit 0
			fi
		fi
	done

	# If no applications are currently using the NVIDIA GPU, avoid nvidia-smi to allow it to enter D3cold.
	# Filter out passive desktop daemons (like xdg-desktop-portal or browser decoder workers) that hold idle FDs.
	if checkcommand fuser; then
		active_pids=$(fuser /dev/nvidia0 /dev/nvidiactl /dev/dri/renderD129 2>/dev/null)
		if [ -z "$active_pids" ]; then
			echo "0"
			echo "0"
			echo "0"
			exit 0
		fi
		has_active_client=false
		for pid in $active_pids; do
			comm=$(cat "/proc/$pid/comm" 2>/dev/null)
			case "$comm" in
				xdg-desktop-por*|RDD\ Process|gnome-shell*|"")
					;;
				*)
					has_active_client=true
					break
					;;
			esac
		done
		if [ "$has_active_client" = false ]; then
			echo "0"
			echo "0"
			echo "0"
			exit 0
		fi
	fi

	nvidia-smi -i "$GPU_INDEX" --query-gpu=memory.total,memory.used,utilization.gpu --format=csv,noheader,nounits 2>/dev/null | while IFS=', ' read -r a b c; do echo "$a"; echo "$b"; echo "$c"; done

elif lsmod | grep amdgpu > /dev/null; then
	# DRM card numbers don't always start at 0 (the GPU can be card1 with
	# no card0, e.g. alongside an integrated GPU), so map the index to the
	# Nth card that exposes amdgpu's vram counters.
	card=""
	i=0
	for d in /sys/class/drm/card[0-9] /sys/class/drm/card[0-9][0-9]; do
		[ -e "$d/device/mem_info_vram_total" ] || continue
		if [ "$i" -eq "$GPU_INDEX" ]; then
			card=${d##*/}
			break
		fi
		i=$((i + 1))
	done
	[ -n "$card" ] || card="card$GPU_INDEX"

	total=$(cat "/sys/class/drm/$card/device/mem_info_vram_total")
	echo $((total / 1024 / 1024))

	used=$(cat "/sys/class/drm/$card/device/mem_info_vram_used")
	echo $((used / 1024 / 1024))

	cat "/sys/class/drm/$card/device/gpu_busy_percent"

elif checkcommand glxinfo; then
	TOTALVRAM=$(glxinfo | grep -A2 -i GL_NVX_gpu_memory_info | grep -E -i 'dedicated')
	TOTALVRAM=${TOTALVRAM##*:[[:blank:]]}
	TOTALVRAM=${TOTALVRAM%%[[:blank:]]MB*}
	AVAILVRAM=$(glxinfo | grep -A4 -i GL_NVX_gpu_memory_info | grep -E -i 'available dedicated')
	AVAILVRAM=${AVAILVRAM##*:[[:blank:]]}
	AVAILVRAM=${AVAILVRAM%%[[:blank:]]MB*}
	FREEVRAM=$((TOTALVRAM - AVAILVRAM))
	echo "$TOTALVRAM"
	echo "$FREEVRAM"

fi
