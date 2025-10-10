# Proto-Scan

Proto-Scan is a web application that scans French Tennis Federation (FFT) licenses using a device's camera. It automatically detects a clear image, extracts the license information using AI, and displays it to the user.

## Features

-   **Camera-based scanning:** Uses the device's camera to capture an image of the license.
-   **Automatic image capture:** Utilizes OpenCV.js to analyze the video stream and automatically capture a sharp image.
-   **AI-powered information extraction:** Employs the Google Gemini AI to extract the following information from the license image:
    -   Last Name
    -   First Name
    -   License Number
    -   Year of Validity
    -   Tennis Ranking
-   **Real-time results:** Displays the extracted information to the user on the web interface.

## Technologies Used

### Backend

-   **Python:** The core language for the backend.
-   **Flask:** A lightweight web framework for Python.
-   **Google Generative AI:** The AI service used for information extraction.
-   **Gunicorn:** A Python WSGI HTTP server for UNIX.

### Frontend

-   **HTML/CSS/JavaScript:** The standard trio for web development.
-   **OpenCV.js:** A JavaScript library for computer vision, used for sharpness detection.

### Containerization

-   **Docker:** The application is containerized for easy deployment.

## Getting Started

### Prerequisites

-   Docker
-   A Google API key with access to the Gemini API.

### Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/your-username/jae-identites.git
    cd jae-identites/proto-scan
    ```
2.  **Create a `.env` file:**
    -   In the `backend` directory, create a file named `.env`.
    -   Add your Google API key to the `.env` file as follows:
        ```
        GOOGLE_API_KEY="YOUR_GOOGLE_API_KEY"
        ```
3.  **Build and run the Docker container:**
    ```bash
    docker build -t proto-scan .
    docker run -p 8080:8080 proto-scan
    ```
4.  **Access the application:**
    -   Open your web browser and navigate to `http://localhost:8080`.

## How it Works

1.  The user points their device's camera at the FFT license.
2.  The frontend, using OpenCV.js, continuously analyzes the video stream for a sharp image.
3.  Once a clear image is detected, it is captured and sent to the Flask backend.
4.  The backend receives the image and sends it to the Google Gemini AI with a prompt to extract the relevant information.
5.  The AI returns the extracted data in JSON format.
6.  The backend sends the JSON data to the frontend.
7.  The frontend displays the extracted information to the user.
