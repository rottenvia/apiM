"""
Build script for nohomo - API MANAGER

Creates a standalone executable (.exe on Windows, app on Mac/Linux)
"""

import subprocess
import sys
import os

def build():
    print("🔨 Building nohomo - API MANAGER...")
    print()
    
    # Install dependencies first
    print("📦 Installing dependencies...")
    subprocess.run([sys.executable, "-m", "pip", "install", "-r", "requirements.txt"], check=True)
    print()
    
    # Build with PyInstaller
    print("🏗️ Creating executable...")
    
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--onefile",
        "--windowed",
        "--name", "nohomo",
        "--add-data", f"plugins.py{os.pathsep}.",
        "--add-data", f"smart_search.py{os.pathsep}.",
        "--add-data", f"api_client.py{os.pathsep}.",
        "--hidden-import", "flet",
        "--hidden-import", "httpx",
        "main.py"
    ]
    
    subprocess.run(cmd, check=True)
    
    print()
    print("✅ Build complete!")
    print()
    print("📁 Your executable is in the 'dist' folder:")
    print("   - Windows: dist/nohomo.exe")
    print("   - Mac/Linux: dist/nohomo")
    print()
    print("🚀 Just double-click to run!")


if __name__ == "__main__":
    build()
