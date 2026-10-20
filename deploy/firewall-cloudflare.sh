#!/usr/bin/env bash
# Lets only Cloudflare reach ports 80/443 on this VPS, including ports published by Docker (which bypass ufw).
# Run as root on the VPS after Docker is installed; re-run after a reboot (or install iptables-persistent) and now
# and then to pick up Cloudflare's current ranges. Usage: sudo bash deploy/firewall-cloudflare.sh
set -euo pipefail

v4=$(curl -fsS https://www.cloudflare.com/ips-v4)
v6=$(curl -fsS https://www.cloudflare.com/ips-v6)

for cmd in iptables ip6tables; do
  ranges=$v4
  [ "$cmd" = ip6tables ] && ranges=$v6
  # DOCKER-USER is evaluated before Docker's own rules for every published port
  $cmd -N DOCKER-USER 2>/dev/null || true
  $cmd -F DOCKER-USER
  $cmd -A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
  for r in $ranges; do
    $cmd -A DOCKER-USER -p tcp -m multiport --dports 80,443 -s "$r" -j RETURN
    $cmd -A DOCKER-USER -p udp --dport 443 -s "$r" -j RETURN
  done
  $cmd -A DOCKER-USER -p tcp -m multiport --dports 80,443 -j DROP
  $cmd -A DOCKER-USER -p udp --dport 443 -j DROP
  $cmd -A DOCKER-USER -j RETURN
done
echo "DOCKER-USER now admits only Cloudflare on 80/443."
