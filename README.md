# JAE Identities

This project contains two main modules for scanning and processing identity documents and licenses.

## Modules

### 1. JAE Scanner (`jae-scanner`)

This module is a web-based front-end designed to capture images of documents using a device's camera.

-   **Functionality**: Provides a user interface in the browser to scan documents.
-   **Technology**: Built with Python, Flask, and standard front-end technologies (HTML, CSS, JavaScript).
-   **Output**: Uploads the captured image to a Google Cloud Storage bucket for processing.

### 2. JAE OCR (`jae-ocr`)

This module is a backend service that performs Optical Character Recognition (OCR) on the documents uploaded by the JAE Scanner.

-   **Functionality**:
    -   Triggered by new image uploads to a specific Google Cloud Storage bucket.
    -   Uses the Google Gemini API to extract text and relevant information from the document image.
    -   Saves the extracted data as a structured JSON file in a separate results bucket.
-   **Technology**: A Python-based service that leverages the Google Gemini AI.

## Workflow

1.  The user accesses the **JAE Scanner** web interface and scans a document.
2.  The captured image is uploaded to a Cloud Storage bucket.
3.  The upload triggers the **JAE OCR** service.
4.  **JAE OCR** processes the image with Gemini, extracts the data, and saves the resulting JSON to another Cloud Storage bucket.
