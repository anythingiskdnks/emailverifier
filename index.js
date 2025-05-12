const express = require('express');
const { isEmail } = require('validator');
const deepEmailValidator = require('deep-email-validator');
const dns = require('dns').promises;
const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// List of domains to mark as undeliverable without checks
const undeliverableDomains = [
  'example.com',
  'godaddy.com',
  'test.com',
  'example.org',
  'example.net',
  'invalid.com'
];

// Custom MX record lookup
async function getMxRecords(domain) {
  try {
    const records = await dns.resolveMx(domain);
    return records.map(record => ({ exchange: record.exchange, priority: record.priority }));
  } catch (error) {
    console.error(`MX lookup failed for ${domain}:`, error);
    return [];
  }
}

// Email verification endpoint
app.post('/verify-email', async (req, res) => {
  try {
    const { email } = req.body;

    // Basic email format validation
    if (!email || !isEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const [, domain] = email.split('@');

    // Rule 1: Gmail emails are deliverable without checks
    if (domain.toLowerCase() === 'gmail.com') {
      return res.json({
        email,
        status: 'deliverable',
        willBounce: false,
        details: {
          validFormat: true,
          validMx: true,
          validTypo: true,
          isDisposable: false,
          validSmtp: null,
          reason: 'Gmail domain automatically marked as deliverable',
          additionalInfo: ''
        }
      });
    }

    // Rule 2: Certain domains are undeliverable without checks
    if (undeliverableDomains.includes(domain.toLowerCase())) {
      return res.json({
        email,
        status: 'undeliverable',
        willBounce: true,
        details: {
          validFormat: true,
          validMx: false,
          validTypo: true,
          isDisposable: true,
          validSmtp: null,
          reason: 'Domain marked as undeliverable by rule',
          additionalInfo: 'Checks skipped due to domain rule'
        }
      });
    }

    // Perform deep email validation for other domains (for format, typo, disposable checks)
    const result = await deepEmailValidator.validate({
      email,
      validateRegex: true,
      validateMx: true,
      validateTypo: true,
      validateDisposable: true,
      validateSMTP: false // Disable built-in SMTP
    });

    // Log deep-email-validator MX data for debugging
    console.log('Deep Validator MX for', email, ':', JSON.stringify(result.validators.mx.data, null, 2));

    // Perform manual MX lookup
    const mxRecords = await getMxRecords(domain);
    console.log('Manual MX Records for', email, ':', JSON.stringify(mxRecords, null, 2));

    // Determine deliverability status based on MX records
    const hasMxRecords = mxRecords.length > 0;
    const isValid = hasMxRecords && result.validators.regex.valid && result.validators.typo.valid && result.validators.disposable.valid;
    const status = isValid ? 'deliverable' : 'undeliverable';
    const willBounce = !isValid;
    const reason = isValid
      ? 'Email is valid with MX records'
      : hasMxRecords
      ? 'Validation failed (format, typo, or disposable)'
      : 'No MX records found';

    res.json({
      email,
      status,
      willBounce,
      details: {
        validFormat: result.validators.regex.valid,
        validMx: hasMxRecords || result.validators.mx.valid,
        validTypo: result.validators.typo.valid,
        isDisposable: !result.validators.disposable.valid,
        validSmtp: null, // SMTP not checked
        reason: reason,
        additionalInfo: hasMxRecords ? 'Deliverable based on MX records' : 'No MX records found for domain'
      }
    });
  } catch (error) {
    console.error('Error verifying email:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
