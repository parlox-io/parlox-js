___INFO___

{
  "type": "TAG",
  "id": "cvt_parlox",
  "version": 1,
  "securityGroups": [],
  "displayName": "Parlox agent analytics",
  "brand": {
    "id": "parlox",
    "displayName": "Parlox"
  },
  "description": "Loads the Parlox browser snippet, which measures AI-agent visits on a storefront. Reads no field values, sets no cookies.",
  "containerContexts": [
    "WEB"
  ]
}


___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "publicKey",
    "displayName": "Public key",
    "simpleValueType": true,
    "help": "The site's public key from the Parlox dashboard (starts with pk_). It is safe to expose in page source.",
    "valueValidators": [
      {
        "type": "REGEX",
        "args": [
          "^pk_[A-Za-z0-9_-]{3,64}$"
        ]
      }
    ]
  },
  {
    "type": "CHECKBOX",
    "name": "consentRequired",
    "checkboxText": "Wait for consent (the site calls parlox.consent(true))",
    "simpleValueType": true,
    "help": "Leave unchecked if this tag already fires only after consent through a trigger. Check it if the tag fires on every page and consent is signalled later by calling window.parlox.consent(true)."
  }
]


___SANDBOXED_JS_FOR_WEB_TEMPLATE___

const injectScript = require('injectScript');
const encodeUriComponent = require('encodeUriComponent');

const url = 'https://gateway.parlox.io/sdk/parlox.js?key=' + encodeUriComponent(data.publicKey) +
  (data.consentRequired ? '&consent=required' : '');

injectScript(url, data.gtmOnSuccess, data.gtmOnFailure, 'parlox');


___WEB_PERMISSIONS___

[
  {
    "instance": {
      "key": {
        "publicId": "inject_script",
        "versionId": "1"
      },
      "param": [
        {
          "key": "urls",
          "value": {
            "type": 2,
            "listItem": [
              {
                "type": 1,
                "string": "https://gateway.parlox.io/sdk/"
              }
            ]
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  }
]


___TESTS___

scenarios:
- name: injects the snippet with the key in the URL
  code: |-
    const mockData = { publicKey: 'pk_test123456', consentRequired: false };
    mock('injectScript', (url, onSuccess, onFailure, cacheToken) => {
      assertThat(url).isEqualTo('https://gateway.parlox.io/sdk/parlox.js?key=pk_test123456');
      onSuccess();
    });
    runCode(mockData);
    assertApi('gtmOnSuccess').wasCalled();
- name: adds consent=required when asked
  code: |-
    const mockData = { publicKey: 'pk_test123456', consentRequired: true };
    mock('injectScript', (url, onSuccess, onFailure, cacheToken) => {
      assertThat(url).isEqualTo('https://gateway.parlox.io/sdk/parlox.js?key=pk_test123456&consent=required');
      onSuccess();
    });
    runCode(mockData);
    assertApi('gtmOnSuccess').wasCalled();


___NOTES___

Import in Google Tag Manager: Templates → Tag Templates → New → ⋮ → Import → this file. Then add a tag of type "Parlox agent analytics" with the site's public key, firing on All Pages (or on your consent-granted trigger).
