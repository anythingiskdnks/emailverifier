const express = require('express');
const { isEmail } = require('validator');
const deepEmailValidator = require('deep-email-validator');
const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Email verification endpoint
app.post('/verify-email', async (req, res) => {
  try {
    const { email } = req.body;

    // Basic email format validation
    if (!email || !isEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Perform deep email validation with SMTP
    const result = await deepEmailValidator.validate({
      email,
      validateRegex: true,
      validateMx: true,
      validateTypo: true,
      validateDisposable: true,
      validateSMTP: true, // Enable SMTP for accurate bounce detection
      timeout: 10000 // 10-second timeout for SMTP checks
    });

    // Determine deliverability status
    const status = result.valid ? 'deliverable' : 'undeliverable';
    const willBounce = !result.valid;
    const reason = !result.valid ? result.reason : 'Email is valid';

    // Safely check if SMTP check timed out
    let smtpFailed = false;
    if (
      result.validators.smtp &&
      !result.validators.smtp.valid &&
      typeof result.validators.smtp.reason === 'string' &&
      result.validators.smtp.reason.includes('timeout')
    ) {
      smtpFailed = true;
    }

    // Add note if SMTP check failed but other checks passed
    const additionalInfo = smtpFailed && result.validators.mx.valid && result.validators.disposable.valid
      ? 'SMTP check failed (possible server restriction), but MX and disposable checks passed.'
      : '';

    res.json({
      email,
      status,
      willBounce,
      details: {
        validFormat: result.validators.regex.valid,
        validMx: result.validators.mx.valid,
        validTypo: result.validators.typo.valid,
        isDisposable: !result.validators.disposable.valid,
        validSmtp: result.validators.smtp ? result.validators.smtp.valid : null,
        reason: reason || 'Email is valid',
        additionalInfo
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
