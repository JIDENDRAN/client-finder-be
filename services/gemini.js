import { GoogleGenerativeAI } from '@google/generative-ai';
import { db } from './db.js';

// Regex-based fallback AI responder for testing when no Gemini key is provided
function generateMockAIResponse(clientMessage, businessName) {
  const msg = clientMessage.toLowerCase();
  let text = '';
  let interest = 'questions';
  let reason = 'Client asked a question.';

  if (msg.includes('yes') || msg.includes('interested') || msg.includes('sure') || msg.includes('ok') || msg.includes('tell me more')) {
    text = `Great! I'm glad to hear that. We can help you set up web development and SEO to boost your local customers. Would you be free for a quick 10-minute Google Meet call tomorrow at 3:00 PM or 5:00 PM?`;
    interest = 'interested';
    reason = 'Client showed clear positive interest.';
  } else if (msg.includes('price') || msg.includes('cost') || msg.includes('much') || msg.includes('rate')) {
    text = `Our web development services typically start at $500 for a custom local site, and SEO monthly plans start at $150. However, we customize our packages for each business. Would you like to hop on a quick call to get an exact quote?`;
    interest = 'questions';
    reason = 'Client asked about pricing/rates.';
  } else if (msg.includes('no') || msg.includes('stop') || msg.includes('don\'t') || msg.includes('busy') || msg.includes('not interested') || msg.includes('unsubscribe')) {
    text = `Understood. Thank you for your time, and have a great day!`;
    interest = 'not_interested';
    reason = 'Client declined or asked to stop.';
  } else if (msg.includes('who is this') || msg.includes('where did you get') || msg.includes('scam') || msg.includes('spam')) {
    text = `Apologies for any inconvenience. I saw your business on Google Maps and thought we could offer valuable digital services. I will note not to contact you further.`;
    interest = 'manual';
    reason = 'Client expressed skepticism or concern.';
  } else {
    text = `Hello! Thanks for replying. We are a digital agency specializing in website design and Google Maps search optimization for local businesses. Are you currently looking to attract more customers from the web?`;
    interest = 'questions';
    reason = 'Client replied with general greeting/neutral statement.';
  }

  return {
    reply: `[Mock AI Assistant for ${businessName}]: ${text}`,
    interest,
    reason
  };
}

export async function generateResponse(leadId, clientMessage) {
  const settings = await db.getSettings();
  let apiKey = process.env.GEMINI_API_KEY || settings.geminiApiKey;
  if (apiKey === 'your_gemini_api_key_here') apiKey = '';
  const businessName = settings.businessName;
  const businessDesc = settings.businessDesc;

  // Fallback if no API key is set
  if (!apiKey) {
    console.log('Gemini API Key is missing. Using local rule-based mock responder.');
    return generateMockAIResponse(clientMessage, businessName);
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    // Use the reliable flash model
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    // Fetch conversation history from the DB
    const historyMessages = await db.getMessages(leadId);
    
    // Format system instruction with business profile details
    let systemInstruction = settings.promptTemplate
      .replace(/{{businessName}}/g, businessName)
      .replace(/{{businessDesc}}/g, businessDesc);

    // Prepare history for Gemini API
    // Exclude the very last message if it's the one we are processing now
    const chatHistory = [];
    const dbHistory = historyMessages.filter(m => m.text !== clientMessage);

    // Gemini chat API requires alternating user/model messages starting with user
    // We will build a clean sequence
    for (const msg of dbHistory) {
      const role = msg.sender === 'client' ? 'user' : 'model';
      
      // If we have back-to-back same roles, combine them to satisfy the API
      if (chatHistory.length > 0 && chatHistory[chatHistory.length - 1].role === role) {
        chatHistory[chatHistory.length - 1].parts[0].text += `\n${msg.text}`;
      } else {
        chatHistory.push({
          role,
          parts: [{ text: msg.text }]
        });
      }
    }

    // Initialize Gemini Chat
    const chat = model.startChat({
      history: chatHistory,
      systemInstruction: systemInstruction
    });

    console.log(`Generating AI reply for lead ${leadId}...`);
    const result = await chat.sendMessage(clientMessage);
    const replyText = result.response.text().trim();

    // Now, classify interest using structured JSON output
    const classifierModel = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      generationConfig: {
        responseMimeType: 'application/json'
      }
    });

    // We'll pass the full conversation including the new reply to the classifier
    const conversationText = [...historyMessages, { sender: 'ai', text: replyText }]
      .map(m => `${m.sender === 'client' ? 'Client' : 'AI Assistant'}: ${m.text}`)
      .join('\n');

    const classificationPrompt = `
You are an expert sales lead analyzer. Analyze the following conversation history between our AI sales assistant and a client business, then classify the client's current interest level.

Conversation History:
${conversationText}

Analyze the client's replies carefully.
Classify the client's interest level into exactly one of these categories:
- "interested": The client shows positive interest, asks for pricing, agrees to schedule a phone call/meeting, or asks to set up a time.
- "questions": The client has general questions or wants more details about services but hasn't agreed to a call yet.
- "not_interested": The client explicitly declined, asked us to stop messaging, said they aren't interested, or accused us of spam.
- "manual": The conversation has become complex or critical, requiring human intervention.
- "none": No meaningful response yet from the client (e.g. only automated away messages).

Response format MUST be a JSON object with this exact structure:
{
  "interest": "interested" | "questions" | "not_interested" | "manual" | "none",
  "reason": "A 1-sentence reason explaining why you chose this classification"
}
`;

    console.log(`Classifying lead interest for lead ${leadId}...`);
    const classificationResult = await classifierModel.generateContent(classificationPrompt);
    const classificationJsonStr = classificationResult.response.text();
    
    let classification = { interest: 'questions', reason: 'Analyzed by Gemini.' };
    try {
      classification = JSON.parse(classificationJsonStr);
    } catch (parseErr) {
      console.error('Failed to parse classification JSON:', parseErr.message, classificationJsonStr);
    }

    return {
      reply: replyText,
      interest: classification.interest,
      reason: classification.reason
    };

  } catch (err) {
    console.error('Error in Gemini service:', err.message);
    // Return fallback response on error so the application doesn't crash
    return {
      reply: `Hi, thank you for your message! Our representatives will get back to you shortly to discuss.`,
      interest: 'manual',
      reason: `Error generating response: ${err.message}`
    };
  }
}
