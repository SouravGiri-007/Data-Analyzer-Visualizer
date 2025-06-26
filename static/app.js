document.addEventListener('DOMContentLoaded', function() {
    const uploadForm = document.getElementById('upload-form');
    const dataPreviewDiv = document.getElementById('data-preview');
    let columns = [];

    function renderTable(preview, columns) {
        let html = '<div class="table-responsive"><table class="table table-striped table-hover">';
        html += '<thead><tr>' + columns.map(col => `<th>${col}</th>`).join('') + '</tr></thead>';
        html += '<tbody>';
        preview.forEach(row => {
            html += '<tr>' + columns.map(col => `<td>${row[col] !== undefined ? row[col] : ''}</td>`).join('') + '</tr>';
        });
        html += '</tbody></table></div>';
        return html;
    }

    function renderSummaryStats(desc, nulls, dtypes) {
        let html = '<div class="card mt-4 mb-2"><div class="card-body">';
        html += '<h5 class="card-title mb-3"><i class="fa-solid fa-chart-simple me-2 text-primary"></i>Summary Statistics</h5>';
        html += '<div class="table-responsive"><table class="table table-bordered table-sm">';
        html += '<thead><tr><th>Stat</th>';
        for (const col in desc) html += `<th>${col}</th>`;
        html += '</tr></thead><tbody>';
        for (const stat in desc[columns[0]] || {}) {
            html += `<tr><td>${stat}</td>`;
            for (const col in desc) html += `<td>${desc[col][stat] !== undefined ? desc[col][stat] : ''}</td>`;
            html += '</tr>';
        }
        html += '<tr><td>Missing</td>';
        for (const col in desc) html += `<td>${nulls[col]}</td>`;
        html += '</tr>';
        html += '<tr><td>Type</td>';
        for (const col in desc) html += `<td>${dtypes[col]}</td>`;
        html += '</tr>';
        html += '</tbody></table></div></div></div>';
        return html;
    }

    function highlightSample(lines, suggestion) {
        if (!lines) return '';
        let html = '<div class="mt-2"><b>File sample (first 20 lines):</b><pre style="background:#f8f9fa; border-radius:8px; padding:8px; max-height:300px; overflow-y:auto;">';
        lines.forEach((line, idx) => {
            if (suggestion && suggestion.skiprows === idx) {
                html += `<span style='background: #ffe082; color: #232946; font-weight: bold;'>${line}</span>\n`;
            } else {
                html += line + '\n';
            }
        });
        html += '</pre></div>';
        return html;
    }

    function showHeaderRowPicker(sampleLines) {
        // Create modal for header row picker
        const modalHtml = `
            <div class="modal fade" id="headerRowModal" tabindex="-1" aria-labelledby="headerRowModalLabel" aria-hidden="true">
                <div class="modal-dialog modal-lg">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title" id="headerRowModalLabel">
                                <i class="fa-solid fa-table me-2"></i>Select Header Row
                            </h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                        </div>
                        <div class="modal-body">
                            <p class="text-muted mb-3">Click on the line that contains your column headers:</p>
                            <div class="sample-lines" style="max-height: 400px; overflow-y: auto;">
                                ${sampleLines.map((line, idx) => `
                                    <div class="sample-line p-2 border-bottom" data-line="${idx}" style="cursor: pointer; transition: background-color 0.2s;">
                                        <small class="text-muted">Line ${idx + 1}:</small><br>
                                        <code>${line}</code>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                            <button type="button" class="btn btn-primary" id="applyHeaderRow">Apply Selection</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        // Remove existing modal if any
        const existingModal = document.getElementById('headerRowModal');
        if (existingModal) {
            existingModal.remove();
        }
        
        // Add new modal to body
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        
        // Show modal
        const modal = new bootstrap.Modal(document.getElementById('headerRowModal'));
        modal.show();
        
        // Handle line selection
        let selectedLine = -1;
        document.querySelectorAll('.sample-line').forEach(line => {
            line.addEventListener('click', function() {
                document.querySelectorAll('.sample-line').forEach(l => l.style.backgroundColor = '');
                this.style.backgroundColor = '#e3f2fd';
                selectedLine = parseInt(this.dataset.line);
            });
        });
        
        // Handle apply button
        document.getElementById('applyHeaderRow').addEventListener('click', function() {
            if (selectedLine >= 0) {
                document.getElementById('skiprows').value = selectedLine;
                modal.hide();
                // Retry upload
                uploadForm.dispatchEvent(new Event('submit'));
            } else {
                alert('Please select a header row first.');
            }
        });
    }

    if (uploadForm) {
        uploadForm.addEventListener('submit', function(e) {
            e.preventDefault();
            const formData = new FormData(uploadForm);
            const fileInput = uploadForm.querySelector('input[type="file"]');
            const file = fileInput.files[0];
            
            // Show file size info for large files
            let loadingMessage = '<div class="text-center text-secondary py-4"><i class="fa-solid fa-spinner fa-spin me-2"></i>Uploading and processing...';
            if (file && file.size > 1024 * 1024) { // If file is larger than 1MB
                const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);
                loadingMessage += `<br><small class="text-muted">File size: ${fileSizeMB}MB - This may take a moment...</small>`;
            }
            loadingMessage += '</div>';
            
            dataPreviewDiv.innerHTML = loadingMessage;
            
            fetch('/upload', {
                method: 'POST',
                body: formData
            })
            .then(async response => {
                let data;
                try {
                    data = await response.json();
                } catch {
                    data = {};
                }
                
                // Prevent rendering table if error or missing data
                if (!response.ok || data.error || !data.columns || !data.preview) {
                    let sampleHtml = '';
                    if (data.sample && data.sample.length) {
                        sampleHtml = highlightSample(data.sample, data.suggestion);
                    }
                    let suggestionHtml = '';
                    if (data.suggestion && typeof data.suggestion.skiprows === 'number') {
                        suggestionHtml = `<div class='mt-2'><button class='btn btn-warning btn-sm' id='applySuggestionBtn'>
                            Try skipping to line ${data.suggestion.skiprows + 1}
                        </button></div>`;
                    }
                    dataPreviewDiv.innerHTML = `
                        <div class='alert alert-danger'>
                            <h5><i class="fa-solid fa-exclamation-triangle me-2"></i>Upload Failed</h5>
                            <p>${data.error || 'Upload failed.'}</p>
                            ${sampleHtml}
                            ${suggestionHtml}
                        </div>`;
                    if (data.suggestion && typeof data.suggestion.skiprows === 'number') {
                        document.getElementById('applySuggestionBtn').onclick = function() {
                            document.getElementById('skiprows').value = data.suggestion.skiprows;
                            uploadForm.dispatchEvent(new Event('submit'));
                        };
                    }
                    return;
                }
                
                columns = data.columns;
                let successHtml = renderTable(data.preview, columns);
                
                // Show file info and delimiter info
                let infoHtml = '';
                if (data.used_delimiter) {
                    infoHtml += `
                        <div class="alert alert-success mb-3">
                            <i class="fa-solid fa-check-circle me-2"></i>
                            File uploaded successfully! Auto-detected delimiter: "${data.used_delimiter.replace('\\t', 'Tab')}"
                        </div>`;
                }
                
                if (data.total_rows && data.total_columns) {
                    infoHtml += `
                        <div class="alert alert-info mb-3">
                            <i class="fa-solid fa-info-circle me-2"></i>
                            Dataset loaded: ${data.total_rows.toLocaleString()} rows × ${data.total_columns} columns
                            ${data.total_rows > 1000 ? '<br><small class="text-muted">Showing first 1,000 rows for preview</small>' : ''}
                        </div>`;
                }
                
                dataPreviewDiv.innerHTML = infoHtml + successHtml + '<div id="summary-stats"></div>';
                
                // Fetch summary stats
                fetch('/summary')
                    .then(resp => resp.json())
                    .then(stats => {
                        if (stats.error) {
                            document.getElementById('summary-stats').innerHTML = `<div class='alert alert-danger'>${stats.error}</div>`;
                        } else {
                            document.getElementById('summary-stats').innerHTML = renderSummaryStats(stats.desc, stats.nulls, stats.dtypes);
                        }
                    });
            })
            .catch((error) => {
                console.error('Upload error:', error);
                dataPreviewDiv.innerHTML = `
                    <div class='alert alert-danger'>
                        <h5><i class="fa-solid fa-exclamation-triangle me-2"></i>Upload Failed</h5>
                        <p>Network error or server issue. Please try again.</p>
                        <small class="text-muted">If this is a large file, it may take longer to process.</small>
                    </div>`;
            });
        });
    }
}); 