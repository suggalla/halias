// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity 0.8.28;

contract TransactVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 16866630861397535508061268716364694259249938394339511734875352420580686553501;
    uint256 constant alphay  = 17520716159822560737285056959632284245058124741522968592348310279469928232716;
    uint256 constant betax1  = 3856413861865682259406125593772489970436434033350188456453307594579869731190;
    uint256 constant betax2  = 13988176118895483991861904558084572334100786266952036084176540328185395712741;
    uint256 constant betay1  = 334362448847226824842955750527379103975927130063427606928961190725655324074;
    uint256 constant betay2  = 3547607775902656698424692392688161652233723705721377817271388643195866972830;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant deltax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant deltay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant deltay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;

    
    uint256 constant IC0x = 16925499563226382822235168637216724055798355078431558419172370310999823136740;
    uint256 constant IC0y = 14643437466506415344043975841023337855636359519670406773407297966215588753042;
    
    uint256 constant IC1x = 4875556169291346597722224038656775146127211334206918396177425807245207965988;
    uint256 constant IC1y = 18913190126937443151514404984281090964303681470437168870961805957388188438659;
    
    uint256 constant IC2x = 17490990007719061326517815872895951903348922477333780476169919963673078614275;
    uint256 constant IC2y = 5311214338690825529951283789757282064658969161889882098553875113782566338978;
    
    uint256 constant IC3x = 3539255439706853779924371635905339165794282528560776442841693670830746978786;
    uint256 constant IC3y = 21850068236391774592170513357833946680140741447211791607258079727017081825308;
    
    uint256 constant IC4x = 3879422336049612029526467187212129080523442590353238349936650846780301906577;
    uint256 constant IC4y = 8647963083690188989406583167990266959625880303136163716778515303889607390521;
    
    uint256 constant IC5x = 8070238761770232468350682802299963174374552288904141482128172165571738293955;
    uint256 constant IC5y = 11832877420863683572717990323183394862938015150171210506095911744625535372823;
    
    uint256 constant IC6x = 9842052237707590714001301909881589589312102367005743501570732400380585889570;
    uint256 constant IC6y = 16770788088523644284056861419176572232341923488247698524128786053228096687984;
    
    uint256 constant IC7x = 19864803033536272640355300975821847562194046163251784695723759122182865788524;
    uint256 constant IC7y = 6018551885865317590899868150398723397849487624146933958343885580304073245147;
    
    uint256 constant IC8x = 13959046276814801022308438856452522370012511893013972071995671785245593463792;
    uint256 constant IC8y = 6133312368664570397215065054084730275486265514935478269386265910706696706337;
    
    uint256 constant IC9x = 19249933125137551926301505373170007668673341043142608043422083786118747727131;
    uint256 constant IC9y = 5963919312834693675507792674271065546045422464791572388297910981217710032904;
    
    uint256 constant IC10x = 17628981754039874406620398148352678169758122962476127460565686259646330793924;
    uint256 constant IC10y = 530334774103659633976157849792845086527223824896144494127594437751713331337;
    
    uint256 constant IC11x = 6093357985731170351244643382074258894719127682402000771257220971621334672563;
    uint256 constant IC11y = 7517862284557306854100172145336477904007854405628862018398042021416211124769;
    
    uint256 constant IC12x = 13819320707132080625391513124709202222291827007239804933643096137972668861688;
    uint256 constant IC12y = 10680978868381276025175254416301742181584336390799200498434665967032770085540;
    
    uint256 constant IC13x = 4377687536398737569075870916276510091839460862487006361390006893425706498377;
    uint256 constant IC13y = 465931648459941070921681573784941262022722539890244124395874870331099992921;
    
    uint256 constant IC14x = 3183555010899121773365999706200656768891848289534321621546372561147838936883;
    uint256 constant IC14y = 7862691301017425357628930360999035023804836564352453245431675733255567510319;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[14] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
