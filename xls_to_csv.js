const fs = require('fs');
const xlsx = require('xlsx');

/**
 * Parses an Excel file, removes top/bottom rows, and extracts specific columns to a CSV.
 * @param {string} inputFilePath - Path to the source .xls or .xlsx file
 * @param {string} outputFilePath - Path to save the resulting .csv file
 * @param {number} skipTop - Number of rows to remove from the top (default: 20)
 * @param {number} skipBottom - Number of rows to remove from the bottom (default: 9)
 */
function parseExcelToCsv(inputFilePath, outputFilePath, skipTop = 20, skipBottom = 9) {
    try {
        console.log(`Reading file: ${inputFilePath}...`);
        
        const workbook = xlsx.readFile(inputFilePath);
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        
        // Convert sheet to Array of Arrays
        const rawData = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
        
        if (rawData.length <= (skipTop + skipBottom)) {
            console.error(`Error: The file only has ${rawData.length} rows, which is not enough to process.`);
            return;
        }

        // 1. Slice to remove top and bottom rows
        const slicedData = rawData.slice(skipTop, rawData.length - skipBottom);
        
        // 2. Identify the indices of the desired columns
        const headerRow = slicedData[0] || [];

        console.log(headerRow);
        
        // Target columns normalized to lowercase for safe matching
        // Note: Assumed 'data' from prompt meant 'date' based on standard bank statement headers
        const desiredColumns = [
            'Date',
            'Particulars',
            'Tran Type',
            'Tran ID',
            'Cheque Details',
            'Withdrawals',
            'Deposits',
        ];

        const targetIndices = [];
        
        // Find where each desired column is located in the actual header row
        desiredColumns.forEach(targetCol => {
            const index = headerRow.findIndex(cell => 
                typeof cell === 'string' && cell.trim() === targetCol
            );
            
            if (index !== -1) {
                targetIndices.push(index);
            } else {
                console.warn(`Warning: Column '${targetCol}' not found in the header row.`);
            }
        });

        // 3. Filter the data to only include those specific columns
        const filteredData = slicedData.map(row => {
            return targetIndices.map(index => row[index]);
        });

        console.log(`Data filtered. Generating CSV with ${filteredData[0].length} columns...`);

        // 4. Convert the filtered array back to a worksheet, then to CSV
        const newWorksheet = xlsx.utils.aoa_to_sheet(filteredData);
        const csvData = xlsx.utils.sheet_to_csv(newWorksheet);

        // 5. Write to file
        fs.writeFileSync(outputFilePath, csvData, 'utf8');
        
        console.log(`Success! Parsed CSV saved to: ${outputFilePath}`);

    } catch (error) {
        console.error('An error occurred during parsing:', error.message);
    }
}

// Export the module so it can be used in your main project flow
module.exports = { parseExcelToCsv };

// Example Usage (Can be removed if imported elsewhere):
// parseExcelToCsv('CustomAccountStatement03-06-2026.xls', 'output.csv', 20, 9);

