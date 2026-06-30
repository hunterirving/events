#!/usr/bin/env python3
"""
Starts HTTP server for local testing
Automatically manages a virtual environment for dependencies
"""

import http.server
import socketserver
import socket
import sys
import os
import subprocess
from pathlib import Path

DEFAULT_PORT = 8000
SCRIPT_DIR = Path(__file__).parent.absolute()
VENV_DIR = SCRIPT_DIR / "venv"


def setup_venv():
	"""Create and setup virtual environment if it doesn't exist"""
	# Determine the path to pip and python in the venv
	if sys.platform == "win32":
		pip_path = VENV_DIR / "Scripts" / "pip"
		python_path = VENV_DIR / "Scripts" / "python"
	else:
		pip_path = VENV_DIR / "bin" / "pip"
		python_path = VENV_DIR / "bin" / "python3"

	# Check if venv needs to be created or recreated
	if not VENV_DIR.exists() or not python_path.exists():
		if VENV_DIR.exists():
			print("Virtual environment incomplete, recreating...")
			import shutil
			shutil.rmtree(VENV_DIR)
		else:
			print("Creating virtual environment...")

		try:
			subprocess.check_call([sys.executable, "-m", "venv", str(VENV_DIR)])
			print("Virtual environment created successfully.")
		except subprocess.CalledProcessError as e:
			print(f"Error creating virtual environment: {e}")
			sys.exit(1)

	# Ensure pip is available
	if not pip_path.exists():
		print("Installing pip in virtual environment...")
		try:
			subprocess.check_call([str(python_path), "-m", "ensurepip", "--upgrade"])
		except subprocess.CalledProcessError as e:
			print(f"Error ensuring pip: {e}")
			sys.exit(1)

	check = subprocess.run(
		[str(python_path), "-c", "import qrcode"],
		capture_output=True
	)
	if check.returncode != 0:
		try:
			subprocess.check_call([str(python_path), "-m", "pip", "install", "-q", "qrcode"])
		except subprocess.CalledProcessError:
			print("Note: Could not install qrcode (offline?). QR codes will be unavailable.\n")

	return python_path


def run_in_venv():
	"""Re-run this script in the virtual environment"""
	python_path = setup_venv()

	# Re-run this script with the venv Python
	try:
		subprocess.check_call([str(python_path), __file__, "--in-venv"])
	except (KeyboardInterrupt, subprocess.CalledProcessError):
		pass
	sys.exit(0)


def get_local_ip():
	"""Get the LAN IP other devices on the network can reach this machine at,
	or None if it can't be determined."""
	try:
		# Connect to a public DNS server (doesn't actually send data) to learn
		# which local interface/IP would be used to reach the network.
		s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
		s.connect(("8.8.8.8", 80))
		local_ip = s.getsockname()[0]
		s.close()
		return local_ip
	except Exception:
		return None


def find_available_port(start_port=DEFAULT_PORT, max_attempts=20):
	"""Return the first bindable port at or after start_port. Uses SO_REUSEADDR
	so a socket lingering in TIME_WAIT from a prior run doesn't block us."""
	for port in range(start_port, start_port + max_attempts):
		s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
		s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
		try:
			s.bind(("", port))
			return port
		except OSError:
			continue
		finally:
			s.close()
	return None


def print_qr_code(url, caption="Scan to connect:"):
	"""Generate and print a QR code using block characters."""
	try:
		import qrcode

		qr = qrcode.QRCode(
			version=1,
			error_correction=qrcode.constants.ERROR_CORRECT_L,
			box_size=1,
			border=1,
		)
		qr.add_data(url)
		qr.make(fit=True)

		matrix = qr.get_matrix()

		# Half-block chars pack two matrix rows per terminal line, keeping the
		# code compact and roughly square.
		print(f"\n{caption}\n")
		for y in range(0, len(matrix), 2):
			line = " "
			for x in range(len(matrix[y])):
				top = matrix[y][x]
				bottom = matrix[y + 1][x] if y + 1 < len(matrix) else False
				if top and bottom:
					line += "█"
				elif top:
					line += "▀"
				elif bottom:
					line += "▄"
				else:
					line += " "
			print(line)
	except ImportError:
		print(f"\n{caption}\n  (QR unavailable; open this URL manually) {url}")
	except Exception as e:
		print(f"\nCould not generate QR code: {e}\n  open manually: {url}")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
	"""SimpleHTTPRequestHandler that keeps connections alive, disables caching,
	silences logging, and swallows broken-pipe noise. Shared by serve.py and
	https_serve.py."""
	# HTTP/1.1 keeps the connection alive across requests so loading the app's
	# files reuses one connection instead of a fresh one per file. Requires a
	# threaded server, or a held-open connection would block all others.
	protocol_version = "HTTP/1.1"

	def end_headers(self):
		self.send_header("Cache-Control", "no-cache")
		super().end_headers()

	def log_message(self, format, *args):
		pass

	def handle(self):
		try:
			super().handle()
		except (BrokenPipeError, ConnectionResetError):
			# Browser cancelled the request (normal for media streaming/preloading)
			pass


def start_server():
	"""Start the HTTP server (runs after venv is set up)"""
	# Change to script directory
	os.chdir(SCRIPT_DIR)

	# Find an available port
	port = find_available_port(DEFAULT_PORT)

	if port is None:
		print(f"Error: Could not find an available port (tried {DEFAULT_PORT}-{DEFAULT_PORT + 19})")
		sys.exit(1)

	# Get local IP for network access
	local_ip = get_local_ip()

	try:
		with socketserver.ThreadingTCPServer(("", port), QuietHandler) as httpd:
			httpd.daemon_threads = True
			local_url = f"http://localhost:{port}"

			print(f"\nServer running on port {port}")
			print(f"Local access:   {local_url}")

			if local_ip:
				network_url = f"http://{local_ip}:{port}"
				print(f"Network access: {network_url}")
				print_qr_code(network_url)
			else:
				print("Network access: unavailable (could not determine LAN IP)")

			print("\nPress Ctrl+C to stop the server")

			# Serve forever
			httpd.serve_forever()

	except KeyboardInterrupt:
		print("\n\nShutting down server...")
		sys.exit(0)
	except Exception as e:
		print(f"\nError starting server: {e}")
		sys.exit(1)


def main():
	"""Main entry point"""
	# Check if we're already running in venv
	if "--in-venv" not in sys.argv:
		run_in_venv()
	else:
		start_server()


if __name__ == "__main__":
	main()
