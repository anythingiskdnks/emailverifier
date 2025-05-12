const express = require('express');
const { isEmail } = require('validator');
const deepEmailValidator = require('deep-email-validator');
const dns = require('dns').promises;
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// QuickEmailVerification API key (replace with your key or use environment variable)
const QEV_API_KEY = process.env.QEV_API_KEY || 'your-quickemailverification-api-key';

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

// QuickEmailVerification SMTP check
async function quickEmailVerificationCheck(email) {
  try {
    const response = await axios.get('https://api.quickemailverification.com/v1/verify', {
      params: {
        api_key: QEV_API_KEY,
        email: email
      }
    });
    console.log(`QuickEmailVerification response for ${email}:`, JSON.stringify(response.data, null, 2));

    if (response.data.result === 'valid') {
      return { valid: true, reason: 'SMTP check successful via QuickEmailVerification' };
    } else if (response.data.result === 'invalid') {
      return { valid: false, reason: `SMTP check failed: ${response.data.reason || 'Invalid email'}` };
    } else {
      return { valid: null, reason: `SMTP check inconclusive: ${response.data.reason || 'Unknown response'}` };
    }
  } catch (error) {
    console.error(`QuickEmailVerification error for ${email}:`, error.response ? error.response.data : error.message);
    return { valid: null, reason: `QuickEmailVerification API error: ${error.message}` };
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

    // Perform deep email validation without SMTP
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
    const [, domain] = email.split('@');
    const mxRecords = await getMxRecords(domain);
    console.log('Manual MX Records for', email, ':', JSON.stringify(mxRecords, null, 2));

    // QuickEmailVerification SMTP check (mandatory)
    const smtpResult = await quickEmailVerificationCheck(email);

    // Determine deliverability status (SMTP check is mandatory)
    const isValid = smtpResult.valid === true;
    const status = isValid ? 'deliverable' : 'undeliverable';
    const willBounce = !isValid;
    const reason = isValid ? 'Email is valid' : smtpResult.reason;

    res.json({
      email,
      status,
      willBounce,
      details: {
        validFormat: result.validators.regex.valid,
        validMx: result.validators.mx.valid,
        validTypo: result.validators.typo.valid,
        isDisposable: !result.validators.disposable.valid,
        validSmtp: smtpResult.valid,
        reason: reason,
        additionalInfo: smtpResult.valid === false
          ? `SMTP check failed: ${smtpResult.reason}`
          : smtpResult.valid === null
          ? `SMTP check inconclusive: ${smtpResult.reason}`
          : ''
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
