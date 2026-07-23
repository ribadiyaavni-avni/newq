#!/usr/bin/env bash
# NEWQ launcher (Linux / macOS)
python3 -m venv venv 2>/dev/null || true
source venv/bin/activate
pip install -r requirements.txt -q
python app.py
