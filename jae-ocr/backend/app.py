import os
from flask import Flask, request

print("--- Application starting up! ---")

app = Flask(__name__)
print("--- Flask app created! ---")

@app.route('/', methods=['POST'])
def index():
    print("--- Request received! ---")
    print("Headers:")
    print(request.headers)
    print("Body:")
    print(request.get_data(as_text=True))
    return "", 204

print("--- Application initialized! ---")

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 8080))
    app.run(host='0.0.0.0', port=port)