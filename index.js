import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables.
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const PAST_PERFORMANCE = "TGAIC has rolled out 100+ agents for mid-sized companies in healthcare and legal services. ";

const TGAIC_AGENTS = [
    {
        name: "Nancy",
        industry: "Healthcare",
        function: "Hiring",
        value: "Increases your offer acceptance rates and allows you to increase the pool of available candidates to select from."
    },
    {
        name: "Mark",
        industry: "Healthcare",
        function: "Patient/Caregiver Matching ",
        value: "Increases caregiver and patient satisfaction by matching them with qualitative parameters."
    },
    {
        name: "Betty",
        industry: "Healthcare",
        function: "Measure Attrition Risk",
        value: "Measures attrition risk for employees based on operational data. Allows you to intervene and reduce employee turnover."
    },
    {
        name: "Bob",
        industry: "Healthcare",
        function: "Employee Support",
        value: "Guides your homecare employees with policy and process directives."
    },
    {
        name: "Debbie",
        industry: "Healthcare",
        function: "Employee Support",
        value: "Provides latest policy and compliance information on Georgia DBHDD to your behavioral health system employees."
    }    
];

const AGENT_DESIGN_APPROACH = "Understand from the client, what are the most people dependent or high risk parts of their workflow. Create a list of such opportunities that can be solved with Gen AI agents. Then work with users to prioritize these opportunities based on impact.";

const SYSTEM_MESSAGE = `You are an expert sales consultant for The Generative AI Company, LLC (TGAIC). 

Past Performance: ${PAST_PERFORMANCE}

Our Agents:
${TGAIC_AGENTS.map(agent => `- ${agent.name}: ${agent.function} for ${agent.industry} - ${agent.value}`).join('\n')}

Our Agent Design Approach: ${AGENT_DESIGN_APPROACH}

Your primary responsibilities:
- Understand the visitor's role and organization type
- Identify their operational challenges
- Explain how TGAIC can help solve their problems
- Do NOT discuss any pricing information
- When the caller shows interest, collect their name and phone and raise the interest.show event.
- If the caller wants to talk to Saurabh or Rakesh, invoke the call forwarding tool.

Keep responses professional, engaging, and focused on understanding and solving their operational challenges.`;

const VOICE = 'alloy';
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment

// List of Event Types to log to the console. See the OpenAI Realtime API Documentation: https://platform.openai.com/docs/api-reference/realtime
const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created'
];

// Show AI response elapsed timing calculations
const SHOW_TIMING_MATH = false;

// Function to submit data to Retool
async function submitToRetool(customerName, phone, conversationHistory) {
    const response = await fetch('https://api.retool.com/v1/workflows/7910a14b-77aa-437a-a02b-7785cb8ac76b/startTrigger', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Workflow-Api-Key': process.env.RETOOL_WORKFLOW_KEY || '' // Ensure the key is taken from environment variables
        },
        body: JSON.stringify({
            name: customerName,
            phone: phone,
            conversation_history: conversationHistory
        })
    });
    return response.ok;
}

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Route for Twilio to handle incoming calls
// <Say> punctuation to improve text-to-speech translation
fastify.all('/incoming-call', async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say>Welcome to The Generative AI Company. I am a virtual customer advisor.</Say>
                              <Pause length="1"/>
                              <Say>How can I help you today?</Say>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;

    reply.type('text/xml').send(twimlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        // Connection-specific state
        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        // Control initial session with OpenAI
        const initializeSession = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                    tool_choice: 'auto',
                    tools: [
                        {
                            name: 'submitToRetool',
                            type: 'function',
                            description: 'Submits customer data to Retool for processing.',
                            parameters: {
                                type: 'object',
                                properties: {
                                    customerName: { type: 'string' },
                                    phone: { type: 'string' },
                                    conversationHistory: { type: 'string' }
                                },
                                required: ['customerName', 'phone', 'conversationHistory'],
                                additionalProperties: false
                            }
                        },
                        {
                            name: 'callForwarding',
                            type: 'function',
                            description: 'Forwards the call to a specific person based on the caller’s request.',
                            parameters: {
                                type: 'object',
                                properties: {
                                    name: { type: 'string' }
                                },
                                required: ['name'],
                                additionalProperties: false
                            }
                        }
                    ]
                }
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));

            // Uncomment the following line to have AI speak first:
            // sendInitialConversationItem();
        };

        // Send initial conversation item if AI talks first
        const sendInitialConversationItem = () => {
            const initialConversationItem = {
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: 'Greet the user with "Hello there! I am an AI voice assistant powered by Twilio and the OpenAI Realtime API. You can ask me for facts, jokes, or anything you can imagine. How can I help you?"'
                        }
                    ]
                }
            };

            if (SHOW_TIMING_MATH) console.log('Sending initial conversation item:', JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

        // Handle interruption when the caller's speech starts
        const handleSpeechStartedEvent = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
                if (SHOW_TIMING_MATH) console.log(`Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`);

                if (lastAssistantItem) {
                    const truncateEvent = {
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime
                    };
                    if (SHOW_TIMING_MATH) console.log('Sending truncation event:', JSON.stringify(truncateEvent));
                    openAiWs.send(JSON.stringify(truncateEvent));
                }

                connection.send(JSON.stringify({
                    event: 'clear',
                    streamSid: streamSid
                }));

                // Reset
                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
            }
        };

        // Send mark messages to Media Streams so we know if and when AI response playback is finished
        const sendMark = (connection, streamSid) => {
            if (streamSid) {
                const markEvent = {
                    event: 'mark',
                    streamSid: streamSid,
                    mark: { name: 'responsePart' }
                };
                connection.send(JSON.stringify(markEvent));
                markQueue.push('responsePart');
            }
        };

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(initializeSession, 100);
        });

        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));

                    // First delta from a new response starts the elapsed time counter
                    if (!responseStartTimestampTwilio) {
                        responseStartTimestampTwilio = latestMediaTimestamp;
                        if (SHOW_TIMING_MATH) console.log(`Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`);
                    }

                    if (response.item_id) {
                        lastAssistantItem = response.item_id;
                    }
                    
                    sendMark(connection, streamSid);
                }

                if (response.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
                }

                // Capture text information and invoke functions based on the response
                if (response.type === 'text') { // Assuming 'text' is the type for capturing text
                    const textContent = response.content; // Extract text content
                    console.log('Captured text:', textContent);

                    // Check for interest shown and invoke the function
                    if (response.type === 'interest.shown') {
                        const customerName = response.customerName; // Extract name from the response
                        const phone = response.phone; // Extract phone from the response
                        const conversationHistory = messages.map((m) => `${m.role}: ${m.content}`).join('\n');

                        // Submit to Retool
                        submitToRetool(customerName, phone, conversationHistory)
                            .then(success => {
                                if (success) {
                                    console.log('Successfully submitted to Retool');
                                } else {
                                    console.error('Failed to submit to Retool');
                                }
                            });
                    }

                    // Check for call forwarding request
                    if (response.type === 'call.forward') {
                        const name = response.name; // Extract name from the response
                        const forwardingNumbers = {
                            'Saurabh': '7063043893',
                            'Rakesh': '6785221190'
                        };

                        if (forwardingNumbers[name]) {
                            const callForwardingResponse = {
                                type: 'tool.callForwarding',
                                name: name
                            };
                            openAiWs.send(JSON.stringify(callForwardingResponse)); // Invoke the call forwarding tool
                        }
                    }
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (SHOW_TIMING_MATH) console.log(`Received media message with timestamp: ${latestMediaTimestamp}ms`);
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('Incoming stream has started', streamSid);

                        // Reset start and media timestamp on a new stream
                        responseStartTimestampTwilio = null; 
                        latestMediaTimestamp = 0;
                        break;
                    case 'mark':
                        if (markQueue.length > 0) {
                            markQueue.shift();
                        }
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        // Handle connection close
        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected.');
        });

        // Handle WebSocket close and errors
        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

// Handle the call forwarding tool invocation
const handleCallForwarding = (name) => {
    const forwardingNumbers = {
        'Saurabh': '7063043893',
        'Rakesh': '6785221190'
    };

    if (forwardingNumbers[name]) {
        return `<Response><Dial>${forwardingNumbers[name]}</Dial></Response>`;
    }
    return null; // No forwarding needed
};

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});
