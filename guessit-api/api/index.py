from http.server import BaseHTTPRequestHandler
import json
import sys
import os
import inspect

sys.path.insert(0, os.path.dirname(__file__))

try:
    from guessit import guessit
    GUESSIT_AVAILABLE = True
except ImportError:
    GUESSIT_AVAILABLE = False

def serialize_value(value):
    """Convert any value to JSON-serializable format"""
    if value is None:
        return None
    
    # Handle primitives directly
    if isinstance(value, (str, int, float, bool)):
        return value
    
    # Handle lists/tuples
    if isinstance(value, (list, tuple)):
        return [serialize_value(v) for v in value if v is not None]
    
    # Handle dictionaries
    if isinstance(value, dict):
        return {k: serialize_value(v) for k, v in value.items() if v is not None}
    
    # Handle guessit specific objects with .value property
    if hasattr(value, 'value') and not callable(value.value):
        return value.value
    
    # Handle objects with .name property (but not if it's a method)
    if hasattr(value, 'name') and not callable(value.name):
        return value.name
    
    # For any other object, convert to string
    return str(value)

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
    
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        health = {
            "status": "ok",
            "message": "GuessIt API - POST to /api/parse with filename",
            "guessit_available": GUESSIT_AVAILABLE
        }
        self.wfile.write(json.dumps(health).encode('utf-8'))
    
    def do_POST(self):
        try:
            if not GUESSIT_AVAILABLE:
                self._send_error(503, "GuessIt library not available")
                return
                
            content_length = int(self.headers.get('Content-Length', 0))
            if content_length == 0:
                self._send_error(400, "Missing request body")
                return
                
            post_data = self.rfile.read(content_length)
            try:
                data = json.loads(post_data.decode('utf-8'))
            except json.JSONDecodeError:
                self._send_error(400, "Invalid JSON in request body")
                return
            
            filename = data.get('filename', '')
            
            if not filename:
                self._send_error(400, "Missing 'filename' field")
                return
            
            # Parse with guessit
            try:
                result = guessit(filename)
            except Exception as e:
                self._send_error(500, f"GuessIt parsing error: {str(e)}")
                return
            
            # Convert all values to JSON-serializable format
            parsed_result = {}
            for key, value in result.items():
                try:
                    serialized = serialize_value(value)
                    if serialized is not None:
                        parsed_result[key] = serialized
                except Exception:
                    # Skip values that can't be serialized
                    pass
            
            self._send_json(200, parsed_result)
            
        except Exception as e:
            self._send_error(500, f"Internal server error: {str(e)}")
    
    def _send_json(self, status, data):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        response = json.dumps(data, ensure_ascii=False)
        self.wfile.write(response.encode('utf-8'))
    
    def _send_error(self, status, message):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps({"error": message}).encode('utf-8'))

handler = Handler
