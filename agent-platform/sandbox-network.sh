#!/bin/sh
# Host INPUT and inter-network denial supplement Docker's internal bridge.
# Idempotent, additive rules; no flushing of unrelated firewall policy.
set -eu
# Docker can masquerade host-to-own-bridge connections as loopback; allow that
# trusted host path while rejecting every non-Compose interface/source.
iptables -C INPUT -d 192.168.84.1 -p tcp --dport 17892 ! -s 192.168.84.0/24 -j DROP 2>/dev/null && iptables -D INPUT -d 192.168.84.1 -p tcp --dport 17892 ! -s 192.168.84.0/24 -j DROP || true
iptables -C INPUT ! -i lo -d 192.168.84.1 -p tcp --dport 17892 ! -s 192.168.84.0/24 -j DROP 2>/dev/null || iptables -I INPUT 1 ! -i lo -d 192.168.84.1 -p tcp --dport 17892 ! -s 192.168.84.0/24 -j DROP
iptables -C INPUT -s 192.168.85.0/24 -j DROP 2>/dev/null || iptables -I INPUT 1 -s 192.168.85.0/24 -j DROP
iptables -N COPYLEE-TOOLS 2>/dev/null || true
iptables -C COPYLEE-TOOLS -d 192.168.85.0/24 -j RETURN 2>/dev/null || iptables -A COPYLEE-TOOLS -d 192.168.85.0/24 -j RETURN
iptables -C COPYLEE-TOOLS -j DROP 2>/dev/null || iptables -A COPYLEE-TOOLS -j DROP
iptables -C DOCKER-USER -s 192.168.85.0/24 -j COPYLEE-TOOLS 2>/dev/null || iptables -I DOCKER-USER 1 -s 192.168.85.0/24 -j COPYLEE-TOOLS
