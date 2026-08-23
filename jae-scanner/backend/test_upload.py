import requests
from PIL import Image
import io

def create_solid_image():
    # Create a solid red image (should trigger blur detection because variance is 0)
    img = Image.new('RGB', (100, 100), color='red')
    img_byte_arr = io.BytesIO()
    img.save(img_byte_arr, format='JPEG')
    img_byte_arr.seek(0)
    return img_byte_arr

def test_upload():
    url = 'http://localhost:5001/scan'
    files = {'file': ('test_solid_red.jpg', create_solid_image(), 'image/jpeg')}
    
    try:
        response = requests.post(url, files=files)
        print(f"Status Code: {response.status_code}")
        print(f"Response Body: {response.json()}")
        
        if response.status_code == 400 and "Qualité insuffisante" in response.json().get("error", ""):
            print("SUCCESS: Image rejected as expected.")
        else:
            print("FAILURE: Unexpected response.")
            
    except Exception as e:
        print(f"Error during request: {e}")

if __name__ == "__main__":
    test_upload()
