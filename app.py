import os
import pandas as pd
from flask import Flask, render_template, request, jsonify, session, redirect, url_for
import csv
import chardet # type: ignore
import io
import warnings
import re

app = Flask(__name__)
app.secret_key = 'supersecretkey'
# Increase maximum file size to 50MB for large CSV files
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB
UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# Store DataFrame in session (for demo, use global dict; for prod, use DB or cache)
df_store = {}

@app.route('/')
def index():
    return render_template('index.html')

def detect_encoding(file_bytes):
    """Detect file encoding using chardet"""
    result = chardet.detect(file_bytes)
    return result['encoding'] or 'utf-8'

def detect_header_row(lines, encoding='utf-8'):
    """Smart header detection - finds the most likely header row"""
    if not lines:
        return 0
    
    # Try to decode lines
    decoded_lines = []
    for line in lines[:10]:  # Check first 10 lines
        try:
            if isinstance(line, bytes):
                decoded_lines.append(line.decode(encoding, errors='replace'))
            else:
                decoded_lines.append(line)
        except:
            decoded_lines.append(str(line))
    
    # Look for patterns that suggest a header
    for idx, line in enumerate(decoded_lines):
        # Skip empty lines
        if not line.strip():
            continue
            
        # Check if line has delimiters
        delimiter_count = max(
            line.count(','),
            line.count(';'), 
            line.count('\t'),
            line.count('|')
        )
        
        if delimiter_count == 0:
            continue  # Not a CSV-like line
            
        # Split by most common delimiter
        if line.count(',') >= delimiter_count:
            parts = line.split(',')
        elif line.count(';') >= delimiter_count:
            parts = line.split(';')
        elif line.count('\t') >= delimiter_count:
            parts = line.split('\t')
        else:
            parts = line.split('|')
        
        # Clean parts
        parts = [p.strip().strip('"\'') for p in parts]
        
        # Header characteristics:
        # 1. Not all numeric
        # 2. Has reasonable length strings
        # 3. Doesn't look like data
        numeric_parts = 0
        reasonable_length = 0
        
        for part in parts:
            if part:
                # Check if it's purely numeric (including decimals)
                if re.match(r'^-?\d+\.?\d*$', part):
                    numeric_parts += 1
                # Check if it has reasonable length for a header
                if 2 <= len(part) <= 50:
                    reasonable_length += 1
        
        # If less than 80% are numeric and we have reasonable length strings
        if len(parts) > 1 and numeric_parts / len(parts) < 0.8 and reasonable_length >= len(parts) * 0.5:
            return idx
    
    return 0  # Default to first row

def smart_delimiter_detection(file_bytes, encoding='utf-8', skiprows=0):
    """Enhanced delimiter detection"""
    try:
        # Get sample lines
        lines = file_bytes.splitlines()
        if skiprows >= len(lines):
            skiprows = 0
            
        sample_lines = lines[skiprows:skiprows+10]
        sample_text = b'\n'.join(sample_lines).decode(encoding, errors='replace')
        
        # Count potential delimiters
        delimiter_scores = {}
        for delim in [',', ';', '\t', '|']:
            # Count occurrences across lines
            counts = []
            for line in sample_lines:
                line_text = line.decode(encoding, errors='replace') if isinstance(line, bytes) else line
                counts.append(line_text.count(delim))
            
            # Good delimiter should have consistent counts > 0
            if counts and max(counts) > 0:
                # Score based on consistency and frequency
                avg_count = sum(counts) / len(counts)
                consistency = 1 - (max(counts) - min(counts)) / max(max(counts), 1)
                delimiter_scores[delim] = avg_count * consistency
        
        # Try CSV sniffer as backup
        try:
            if sample_text.strip():
                sniffed = csv.Sniffer().sniff(sample_text, delimiters=',;\t|')
                if sniffed.delimiter not in delimiter_scores:
                    delimiter_scores[sniffed.delimiter] = 1.0
                else:
                    delimiter_scores[sniffed.delimiter] += 0.5  # Boost sniffed delimiter
        except:
            pass
        
        # Return best delimiter
        if delimiter_scores:
            return max(delimiter_scores.items(), key=lambda x: x[1])[0]
        
        return ','  # Default fallback
        
    except Exception:
        return ','

def read_csv_robust(file_bytes, skiprows=0, delimiter=',', nrows=1000):
    """Robust CSV reader with better error handling"""
    enc = detect_encoding(file_bytes)
    
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            df = pd.read_csv(
                io.BytesIO(file_bytes),
                skiprows=skiprows,
                delimiter=delimiter,
                encoding=enc,
                nrows=nrows,
                dtype=str,
                on_bad_lines='skip',
                engine='python'  # More forgiving engine
            )
            return df
        except Exception as e:
            # Try with different parameters
            try:
                df = pd.read_csv(
                    io.BytesIO(file_bytes),
                    skiprows=skiprows,
                    sep=delimiter,
                    encoding=enc,
                    nrows=nrows,
                    dtype=str,
                    on_bad_lines='skip',
                    engine='python',
                    quoting=csv.QUOTE_MINIMAL
                )
                return df
            except:
                raise e

@app.route('/upload', methods=['GET', 'POST'])
def upload():
    if request.method == 'GET':
        return redirect(url_for('index'))
    
    if 'datafile' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    
    file = request.files['datafile']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400
    
    # Get parameters
    delimiter = request.form.get('delimiter', 'auto')  
    skiprows = int(request.form.get('skiprows', -1))  # -1 means auto-detect
    
    # Read file
    file_bytes = file.read()
    enc = detect_encoding(file_bytes)
    
    try:
        # Auto-detect header row if not specified
        if skiprows == -1:
            lines = file_bytes.splitlines()
            skiprows = detect_header_row(lines, enc)
        
        # Auto-detect delimiter if needed
        if delimiter == 'auto':
            delimiter = smart_delimiter_detection(file_bytes, enc, skiprows)
        
        # Try to read the CSV
        df = read_csv_robust(file_bytes, skiprows=skiprows, delimiter=delimiter, nrows=1000)
        
        # Validate the result
        if df.empty:
            raise ValueError("No data found after parsing")
        
        # If we only got one column, the delimiter might be wrong
        if len(df.columns) == 1 and delimiter != 'auto':
            # Try auto-detection
            auto_delimiter = smart_delimiter_detection(file_bytes, enc, skiprows)
            if auto_delimiter != delimiter:
                df = read_csv_robust(file_bytes, skiprows=skiprows, delimiter=auto_delimiter, nrows=1000)
                delimiter = auto_delimiter
        
        # Get total row count
        total_rows = sum(1 for _ in pd.read_csv(
            io.BytesIO(file_bytes), 
            skiprows=skiprows, 
            delimiter=delimiter, 
            encoding=enc, 
            dtype=str, 
            on_bad_lines='skip',
            engine='python'
        ))
        
        # Store in session
        session_id = session.get('sid') or os.urandom(8).hex()
        session['sid'] = session_id
        df_store[session_id] = df
        
        # Prepare response
        preview = df.head(20).to_dict(orient='records')
        columns = list(df.columns)
        
        return jsonify({
            'preview': preview,
            'columns': columns,
            'used_delimiter': delimiter,
            'used_skiprows': skiprows,
            'total_rows': total_rows,
            'total_columns': len(df.columns)
        })
        
    except Exception as e:
        # If all else fails, provide debugging info
        try:
            lines = file_bytes.decode(enc, errors='replace').splitlines()
            return jsonify({
                'error': f'Could not parse file: {str(e)}',
                'sample': lines[:20],
                'detected_encoding': enc,
                'suggestion': {
                    'skiprows': detect_header_row(file_bytes.splitlines(), enc),
                    'delimiter': smart_delimiter_detection(file_bytes, enc)
                }
            }), 400
        except:
            return jsonify({
                'error': f'Could not parse file: {str(e)}',
                'suggestion': {'skiprows': 0, 'delimiter': ','}
            }), 400

@app.route('/summary', methods=['GET'])
def summary():
    session_id = session.get('sid')
    if not session_id or session_id not in df_store:
        return jsonify({'error': 'No data loaded'}), 400
    
    df = df_store[session_id]
    desc = df.describe(include='all').fillna('').to_dict()
    nulls = df.isnull().sum().to_dict()
    dtypes = df.dtypes.astype(str).to_dict()
    
    return jsonify({'desc': desc, 'nulls': nulls, 'dtypes': dtypes})

@app.errorhandler(Exception)
def handle_exception(e):
    import traceback
    return jsonify({
        'error': 'Server error: ' + str(e),
        'trace': traceback.format_exc()
    }), 500

if __name__ == '__main__':
    app.run(debug=True)